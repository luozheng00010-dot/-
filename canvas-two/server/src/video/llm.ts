import type { ModelChannel } from "@prisma/client";
import type { ZodType } from "zod";
import { mergeUpstreamUrl, safeUpstreamError } from "../ai-utils.js";
import { prisma } from "../db.js";
import { decryptSecret } from "../security.js";

/**
 * 自动剪辑 LLM 接入层：复用现有 ModelChannel（OpenAI 兼容接口）。
 * 管理员通过 VideoSetting 指定拆句/匹配（chat）与打标（vision）模型；
 * 未指定时自动挑选第一个可用的 OpenAI 兼容渠道。
 */

export type VideoModelKind = "chat" | "vision";

export interface VideoLlmConfig {
    channel: ModelChannel;
    model: string;
}

export class VideoLlmError extends Error {
    status: number;
    constructor(message: string, status = 502) {
        super(message);
        this.status = status;
    }
}

const VISION_HINT = /vl|vision|qwen[-_.]?v\d/i;

async function autoPickChannel(kind: VideoModelKind): Promise<{ channel: ModelChannel; model: string } | null> {
    const channels = await prisma.modelChannel.findMany({
        where: { enabled: true },
        include: { models: { where: { enabled: true } } },
        orderBy: { createdAt: "asc" },
    });
    for (const channel of channels) {
        if (channel.apiFormat === "gemini") continue; // 仅支持 OpenAI 兼容（含 ark）接口，同 kb
        const model = kind === "vision"
            ? channel.models.find((item) => VISION_HINT.test(item.name)) || null
            : channel.models.find((item) => item.capability === "text") || null;
        if (model) return { channel, model: model.name };
    }
    return null;
}

export async function resolveVideoModel(kind: VideoModelKind): Promise<VideoLlmConfig> {
    const settings = await prisma.videoSetting.findUnique({ where: { id: "default" } });
    const channelId = kind === "chat" ? settings?.chatChannelId : settings?.visionChannelId;
    const modelName = kind === "chat" ? settings?.chatModel : settings?.visionModel;
    if (channelId && modelName) {
        const channel = await prisma.modelChannel.findUnique({ where: { id: channelId } });
        if (!channel || !channel.enabled) throw new VideoLlmError("自动剪辑模型渠道已失效，请管理员重新配置", 500);
        if (channel.apiFormat === "gemini") throw new VideoLlmError("Gemini 格式渠道暂不支持自动剪辑，请选用 OpenAI 兼容渠道", 500);
        return { channel, model: modelName };
    }
    const picked = await autoPickChannel(kind);
    if (!picked) {
        throw new VideoLlmError(kind === "vision" ? "未找到可用的视觉模型渠道，请管理员配置" : "未找到可用的对话模型渠道，请管理员配置", 500);
    }
    return picked;
}

interface ChatRequestMessage {
    role: "system" | "user";
    content: unknown; // 文本对话为 string，视觉打标为多模态数组
}

/** OpenAI 兼容 chat/completions：response_format json_object，返回首个 choice 的文本内容 */
async function requestContent(config: VideoLlmConfig, messages: ChatRequestMessage[]): Promise<string> {
    const apiKey = decryptSecret(config.channel.apiKeyEncrypted);
    const url = mergeUpstreamUrl(config.channel.baseUrl, "/v1/chat/completions");
    let response: Response;
    try {
        response = await fetch(url, {
            method: "POST",
            headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
            body: JSON.stringify({ model: config.model, messages, temperature: 0.3, response_format: { type: "json_object" } }),
            signal: AbortSignal.timeout(120_000),
        });
    } catch (error) {
        if (error instanceof DOMException && error.name === "TimeoutError") throw new VideoLlmError("模型请求超时");
        throw new VideoLlmError("无法连接模型服务，请检查渠道配置与网络");
    }
    const text = await response.text();
    let payload: any;
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = null; }
    if (!response.ok) throw new VideoLlmError(safeUpstreamError(payload, text || response.statusText, response.status, apiKey, "模型请求失败"));
    if (!payload) throw new VideoLlmError("模型服务返回了无法解析的数据，请检查渠道接口兼容性");
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) throw new VideoLlmError("模型未返回有效内容");
    return content.trim();
}

interface ValidateResult<T> {
    ok: boolean;
    value?: T;
    error?: string;
    raw: string;
}

/** 解析模型输出（容忍 ```json 围栏）并用 zod 校验，失败时给出可读错误文本（供重试拼回 prompt） */
function validateJsonContent<T>(content: string, schema: ZodType<T>): ValidateResult<T> {
    let normalized = content.trim();
    const fence = normalized.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
    if (fence) normalized = fence[1].trim();
    let data: unknown;
    try {
        data = JSON.parse(normalized);
    } catch {
        return { ok: false, error: "输出不是合法的 JSON", raw: content };
    }
    const result = schema.safeParse(data);
    if (result.success) return { ok: true, value: result.data, raw: content };
    const error = result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("；");
    return { ok: false, error, raw: content };
}

const RETRY_PROMPT_SUFFIX = (error: string) => `\n\n你上一次的输出未通过校验，错误如下：\n${error}\n请修正问题后重新输出完整的 JSON 对象，只输出 JSON。`;

const RAW_SNIPPET_LIMIT = 500;

/** 文本对话 + JSON 结构化输出：校验失败把错误文本拼进消息重试 1 次，仍失败抛 VideoLlmError（含上游返回片段） */
export async function chatJson<T>(system: string, user: string, schema: ZodType<T>): Promise<T> {
    const config = await resolveVideoModel("chat");
    let userContent = user;
    for (let attempt = 0; attempt < 2; attempt++) {
        const content = await requestContent(config, [
            { role: "system", content: system },
            { role: "user", content: userContent },
        ]);
        const result = validateJsonContent(content, schema);
        if (result.ok) return result.value as T;
        if (attempt === 0) {
            userContent = user + RETRY_PROMPT_SUFFIX(result.error || "未知校验错误");
            continue;
        }
        throw new VideoLlmError(`对话模型输出未通过校验：${result.error || "未知校验错误"}（上游返回片段：${result.raw.slice(0, RAW_SNIPPET_LIMIT)}）`);
    }
    throw new VideoLlmError("对话模型输出未通过校验");
}

/** 视觉打标 + JSON 结构化输出：image_url 传 data URL，校验失败同样重试 1 次 */
export async function visionJson<T>(imageDataUrl: string, prompt: string, schema: ZodType<T>): Promise<T> {
    const config = await resolveVideoModel("vision");
    let textPart = prompt;
    for (let attempt = 0; attempt < 2; attempt++) {
        const content = await requestContent(config, [{
            role: "user",
            content: [
                { type: "text", text: textPart },
                { type: "image_url", image_url: { url: imageDataUrl } },
            ],
        }]);
        const result = validateJsonContent(content, schema);
        if (result.ok) return result.value as T;
        if (attempt === 0) {
            textPart = prompt + RETRY_PROMPT_SUFFIX(result.error || "未知校验错误");
            continue;
        }
        throw new VideoLlmError(`视觉模型输出未通过校验：${result.error || "未知校验错误"}（上游返回片段：${result.raw.slice(0, RAW_SNIPPET_LIMIT)}）`);
    }
    throw new VideoLlmError("视觉模型输出未通过校验");
}

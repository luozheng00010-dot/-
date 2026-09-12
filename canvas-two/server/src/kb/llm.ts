import type { ModelChannel } from "@prisma/client";
import { mergeUpstreamUrl, safeUpstreamError } from "../ai-utils.js";
import { prisma } from "../db.js";
import { decryptSecret } from "../security.js";

/**
 * 知识库 LLM 接入层：复用现有 ModelChannel（OpenAI 兼容接口），
 * 管理员在知识库管理页显式指定对话/向量模型；未指定时自动挑选第一个可用的 text 渠道。
 */

export type KbModelKind = "chat" | "embed";

export interface KbLlmConfig {
    channel: ModelChannel;
    model: string;
}

export class KbLlmError extends Error {
    status: number;
    constructor(message: string, status = 502) {
        super(message);
        this.status = status;
    }
}

const EMBED_HINT = /embed|embedding|向量/i;

async function autoPickChannel(kind: KbModelKind): Promise<{ channel: ModelChannel; model: string } | null> {
    const channels = await prisma.modelChannel.findMany({
        where: { enabled: true },
        include: { models: { where: { enabled: true, capability: "text" }, orderBy: { name: "asc" } } },
        orderBy: { createdAt: "asc" },
    });
    for (const channel of channels) {
        if (channel.apiFormat === "gemini") continue; // MVP 仅支持 OpenAI 兼容（含 ark）接口
        const model = kind === "embed" ? channel.models.find((item) => EMBED_HINT.test(item.name)) || null : channel.models[0] || null;
        if (model) return { channel, model: model.name };
    }
    return null;
}

export async function resolveKbModel(kind: KbModelKind): Promise<KbLlmConfig> {
    const settings = await prisma.kbSetting.findUnique({ where: { id: "default" } });
    const channelId = kind === "chat" ? settings?.chatChannelId : settings?.embedChannelId;
    const modelName = kind === "chat" ? settings?.chatModel : settings?.embedModel;
    if (channelId && modelName) {
        const channel = await prisma.modelChannel.findUnique({ where: { id: channelId } });
        if (!channel || !channel.enabled) throw new KbLlmError("知识库模型渠道已失效，请管理员在知识库管理中重新配置", 500);
        if (channel.apiFormat === "gemini") throw new KbLlmError("Gemini 格式渠道暂不支持知识库，请选用 OpenAI 兼容渠道", 500);
        return { channel, model: modelName };
    }
    const picked = await autoPickChannel(kind);
    if (!picked) {
        throw new KbLlmError(kind === "embed" ? "未找到可用的向量模型渠道，请管理员在知识库管理中配置" : "未找到可用的对话模型渠道，请管理员在知识库管理中配置", 500);
    }
    return picked;
}

async function readUpstreamJson(response: Response, apiKey: string, prefix: string) {
    const text = await response.text();
    let payload: any;
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = null; }
    if (!response.ok) throw new KbLlmError(safeUpstreamError(payload, text || response.statusText, response.status, apiKey, prefix));
    if (!payload) throw new KbLlmError(`${prefix}：服务返回了无法解析的数据，请检查渠道接口兼容性`);
    return payload;
}

export async function createEmbeddings(config: KbLlmConfig, inputs: string[]): Promise<number[][]> {
    const apiKey = decryptSecret(config.channel.apiKeyEncrypted);
    const url = mergeUpstreamUrl(config.channel.baseUrl, "/v1/embeddings");
    let response: Response;
    try {
        response = await fetch(url, {
            method: "POST",
            headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
            body: JSON.stringify({ model: config.model, input: inputs }),
            signal: AbortSignal.timeout(120_000),
        });
    } catch (error) {
        throw new KbLlmError(error instanceof DOMException && error.name === "TimeoutError" ? "向量模型请求超时" : "无法连接向量模型服务，请检查渠道配置与网络");
    }
    const payload = await readUpstreamJson(response, apiKey, "向量模型请求失败");
    const rows = Array.isArray(payload.data) ? payload.data : [];
    const embeddings = rows
        .map((item: any, index: number) => ({ index, vector: Array.isArray(item.embedding) ? item.embedding.map(Number) : null }))
        .filter((item: { index: number; vector: number[] | null }) => Array.isArray(item.vector) && item.vector.length > 0);
    if (embeddings.length !== inputs.length) throw new KbLlmError("向量模型返回的向量数量与请求不一致");
    return embeddings.map((item: { vector: number[] }) => item.vector);
}

interface ChatMessage {
    role: "system" | "user" | "assistant";
    content: string;
}

async function chatCompletions(config: KbLlmConfig, messages: ChatMessage[], stream: boolean, signal: AbortSignal): Promise<Response> {
    const apiKey = decryptSecret(config.channel.apiKeyEncrypted);
    const url = mergeUpstreamUrl(config.channel.baseUrl, "/v1/chat/completions");
    let response: Response;
    try {
        response = await fetch(url, {
            method: "POST",
            headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
            body: JSON.stringify({ model: config.model, messages, stream, temperature: 0.3 }),
            signal,
        });
    } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") throw error;
        throw new KbLlmError("无法连接对话模型服务，请检查渠道配置与网络");
    }
    if (!response.ok) {
        const text = await response.text();
        let payload: any = null;
        try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
        throw new KbLlmError(safeUpstreamError(payload, text || response.statusText, response.status, apiKey, "对话模型请求失败"));
    }
    return response;
}

/** 非流式调用（用于查询改写等轻量场景）；失败返回 null，由调用方兜底 */
export async function chatOnce(config: KbLlmConfig, messages: ChatMessage[]): Promise<string | null> {
    try {
        const response = await chatCompletions(config, messages, false, AbortSignal.timeout(60_000));
        const payload = await response.json();
        const text = payload?.choices?.[0]?.message?.content;
        return typeof text === "string" && text.trim() ? text.trim() : null;
    } catch {
        return null;
    }
}

/**
 * 流式对话：通过 onDelta 回调推送增量，返回完整文本。
 * 解析 OpenAI 兼容 SSE（data: {...} / data: [DONE]）。
 */
export async function streamChat(config: KbLlmConfig, messages: ChatMessage[], onDelta: (delta: string) => void, signal: AbortSignal): Promise<string> {
    const response = await chatCompletions(config, messages, true, signal);
    if (!response.body) throw new KbLlmError("对话模型未返回流式数据");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const data = trimmed.slice(5).trim();
            if (!data || data === "[DONE]") continue;
            let payload: any;
            try { payload = JSON.parse(data); } catch { continue; }
            const delta = payload?.choices?.[0]?.delta?.content;
            if (typeof delta === "string" && delta) {
                full += delta;
                onDelta(delta);
            }
        }
    }
    if (!full.trim()) throw new KbLlmError("对话模型返回了空内容");
    return full;
}

import { createHash, randomInt } from "node:crypto";
import sharp from "sharp";
import { prisma } from "../db.js";
import { decryptSecret } from "../security.js";
import { mergeUpstreamUrl, safeUpstreamError } from "../ai-utils.js";
import { fail } from "./semantic-types.js";

export async function resolveModel(kind: "text" | "vision" | "embed") {
    const s = await prisma.autoVideoSetting.findUnique({ where: { id: "default" } });
    const channelId = kind === "text" ? s?.channelId : kind === "vision" ? s?.visionChannelId : s?.embedChannelId;
    const model = kind === "text" ? s?.model : kind === "vision" ? s?.visionModel : s?.embedModel;
    if (!channelId || !model) throw fail(`请在管理设置配置${{ text: "文案匹配", vision: "视觉分析", embed: "向量检索" }[kind]}模型`);
    const channel = await prisma.modelChannel.findUnique({ where: { id: channelId }, include: { models: true } });
    // Gemini 原生协议只接入了视觉分析（整条视频直传）；文字匹配与向量仍要求 OpenAI 兼容。
    if (!channel?.enabled || (channel.apiFormat === "gemini" && kind !== "vision") || !channel.models.some((m) => m.name === model && m.enabled && m.capability === "text")) throw fail(channel?.apiFormat === "gemini" ? "Gemini 原生渠道仅支持视觉分析，文案匹配与向量请选 OpenAI 兼容渠道" : "模型渠道失效，请检查管理设置");
    const key = createHash("sha256").update(`${channel.id}:${channel.baseUrl}:${model}:${channel.updatedAt.toISOString()}`).digest("hex");
    return { channel, model, key, verified: s?.visionVerified === key };
}
type Model = Awaited<ReturnType<typeof resolveModel>>;
const isGemini = (model: Model) => model.channel.apiFormat === "gemini";

// Gemini 路径布局与 OpenAI 兼容不同：:generateContent 从 baseUrl 的域名根开始拼
// /v1beta/...，不能叠加 base 里已有的 /v1beta 版本段。
function geminiUrl(model: Model, suffix: string): string {
    const url = new URL(model.channel.baseUrl);
    url.pathname = url.pathname.replace(/\/(v1beta|v1)\/?$/, "") + `/${suffix.replace(/^\/+/, "")}`;
    url.search = "";
    url.hash = "";
    return url.toString();
}

// ---- Gemini 原生协议（:generateContent，图片走 inline_data 抽帧）----
async function geminiRequest(model: Model, suffix: string, body: unknown, timeoutMs = 120_000) {
    const key = decryptSecret(model.channel.apiKeyEncrypted);
    let res: Response;
    try {
        res = await fetch(geminiUrl(model, suffix), { method: "POST", headers: { "x-goog-api-key": key, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    } catch { throw fail("模型网络连接失败或超时", 503); }
    const raw = await res.text();
    let data;
    try { data = JSON.parse(raw); } catch { throw fail("模型响应不是有效 JSON", res.status === 429 || res.status >= 500 ? 503 : 422); }
    if (!res.ok) throw fail(safeUpstreamError(data, raw, res.status, key, "语义模型请求失败"), res.status === 429 || res.status >= 500 ? 503 : 422);
    return data;
}
async function call(model: Model, suffix: string, body: unknown) {
    const key = decryptSecret(model.channel.apiKeyEncrypted);
    let res: Response;
    try {
        res = await fetch(mergeUpstreamUrl(model.channel.baseUrl, suffix), { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
    } catch { throw fail("模型网络连接失败或超时", 503); }
    const raw = await res.text();
    let data;
    try { data = JSON.parse(raw); } catch { throw fail("模型响应不是有效 JSON", res.status === 429 || res.status >= 500 ? 503 : 422); }
    if (!res.ok) throw fail(safeUpstreamError(data, raw, res.status, key, "语义模型请求失败"), res.status === 429 || res.status >= 500 ? 503 : 422);
    return data;
}
// 模型有时会在 JSON 前后夹带说明文字，先整段解析，再退到截取首个 { 到最后一个 } 的子串。
function parseModelJson(text: string): unknown {
    const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    try { return JSON.parse(cleaned); } catch { /* fallthrough */ }
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
        try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { /* fallthrough */ }
    }
    throw fail("模型结构化结果无效，请重试", 503);
}

export async function modelJson(model: Model, instruction: string, input: unknown, images: string[] = [], options: { maxTokens?: number } = {}) {
    if (isGemini(model)) {
        const parts: any[] = [];
        parts.push({ text: typeof input === "string" ? input : JSON.stringify(input) });
        for (const image of images) {
            const [header, data] = image.split(",");
            parts.push({ inline_data: { mime_type: header.includes("image/png") ? "image/png" : "image/jpeg", data } });
        }
        const data = await geminiRequest(model, `/v1beta/models/${model.model}:generateContent`, {
            systemInstruction: { parts: [{ text: `${instruction}\n只返回 JSON，不要 Markdown。` }] },
            contents: [{ role: "user", parts }],
            generationConfig: { temperature: 0, ...(options.maxTokens ? { maxOutputTokens: options.maxTokens } : {}) },
        });
        const text = (data.candidates?.[0]?.content?.parts ?? []).map((part: any) => part.text ?? "").join("");
        if (typeof text !== "string" || !text.trim()) throw fail("模型返回空内容：推理型模型的思考占满了输出额度，请在管理设置更换非推理模型", 422);
        return parseModelJson(text);
    }
    const content = images.length ? [{ type: "text", text: JSON.stringify(input) }, ...images.map((url) => ({ type: "image_url", image_url: { url } }))] : JSON.stringify(input);
    // 结构化输出（候选重排、文案拆句等）要求确定性；max_tokens 按调用方估算
    // 给出，避免长输出被供应商截断后解析失败。
    const data = await call(model, "/v1/chat/completions", { model: model.model, stream: false, temperature: 0, ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}), messages: [{ role: "system", content: `${instruction}\n只返回 JSON，不要 Markdown。` }, { role: "user", content }] });
    // 推理型模型（如 deepseek-reasoner）会把输出额度烧在隐藏思考上，content 为空——
    // 重试无济于事，直接给出可操作的提示。
    const text = data.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.trim()) throw fail("模型返回空内容：推理型模型的思考占满了输出额度，请在管理设置更换非推理模型", 422);
    return parseModelJson(text);
}
export async function embedTexts(model: Model, texts: string[]) {
    const data = await call(model, "/v1/embeddings", { model: model.model, input: texts });
    const rows = data.data;
    if (!Array.isArray(rows) || rows.length !== texts.length) throw fail("向量返回数量不正确", 422);
    rows.sort((a, b) => a.index - b.index);
    const vectors: number[][] = rows.map((row, i) => {
        if (row.index !== i || !Array.isArray(row.embedding) || !row.embedding.length || row.embedding.some((v: unknown) => typeof v !== "number" || !Number.isFinite(v)) || !row.embedding.some((v: number) => v !== 0)) throw fail("向量响应无效", 422);
        return row.embedding;
    });
    if (vectors.some((v) => v.length !== vectors[0].length)) throw fail("向量维度不一致", 422);
    return vectors;
}
export const embeddingIdentity = async () => (await resolveModel("embed")).key;
export async function verifyVision() {
    const model = await resolveModel("vision");
    const colors = ["red", "green", "blue", "yellow"];
    for (let i = colors.length-1; i > 0; i--) { const j = randomInt(i+1); [colors[i], colors[j]] = [colors[j], colors[i]]; }
    const tiles = await Promise.all(colors.map(async (color, i) => ({ input: await sharp({ create: { width: 64, height: 64, channels: 3, background: color } }).png().toBuffer(), left: (i%2)*64, top: Math.floor(i/2)*64 })));
    const png = await sharp({ create: { width: 128, height: 128, channels: 3, background: "white" } }).composite(tiles).png().toBuffer();
    const data = (await modelJson(model, '按左上、右上、左下、右下的顺序识别四色方格。返回 {"colors":["red|green|blue|yellow",...]}。', {}, [`data:image/png;base64,${png.toString("base64")}`])) as { colors?: unknown };
    if (JSON.stringify(data.colors) !== JSON.stringify(colors)) throw fail("视觉能力测试失败，请选择支持图片输入的文字模型", 422);
    await prisma.autoVideoSetting.updateMany({ where: { id: "default", visionChannelId: model.channel.id, visionModel: model.model }, data: { visionVerified: model.key } });
}

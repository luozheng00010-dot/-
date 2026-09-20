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
    if (!channel?.enabled || channel.apiFormat === "gemini" || !channel.models.some((m) => m.name === model && m.enabled && m.capability === "text")) throw fail("模型渠道失效，请检查管理设置");
    const key = createHash("sha256").update(`${channel.id}:${channel.baseUrl}:${model}:${channel.updatedAt.toISOString()}`).digest("hex");
    return { channel, model, key, verified: s?.visionVerified === key };
}
type Model = Awaited<ReturnType<typeof resolveModel>>;
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
export async function modelJson(model: Model, instruction: string, input: unknown, images: string[] = [], options: { maxTokens?: number } = {}) {
    const content = images.length ? [{ type: "text", text: JSON.stringify(input) }, ...images.map((url) => ({ type: "image_url", image_url: { url } }))] : JSON.stringify(input);
    // 结构化输出（候选重排、文案拆句等）要求确定性；max_tokens 按调用方估算
    // 给出，避免长输出被供应商截断后解析失败。
    const data = await call(model, "/v1/chat/completions", { model: model.model, stream: false, temperature: 0, ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}), messages: [{ role: "system", content: `${instruction}\n只返回 JSON，不要 Markdown。` }, { role: "user", content }] });
    // 解析失败大多是截断或临时抖动，归类为可重试错误，而不是让整次匹配永久失败。
    try { return JSON.parse(data.choices[0].message.content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")); }
    catch { throw fail("模型结构化结果无效，请重试", 503); }
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
    const data = await modelJson(model, '按左上、右上、左下、右下的顺序识别四色方格。返回 {"colors":["red|green|blue|yellow",...]}。', {}, [`data:image/png;base64,${png.toString("base64")}`]);
    if (JSON.stringify(data.colors) !== JSON.stringify(colors)) throw fail("视觉能力测试失败，请选择支持图片输入的文字模型", 422);
    await prisma.autoVideoSetting.updateMany({ where: { id: "default", visionChannelId: model.channel.id, visionModel: model.model }, data: { visionVerified: model.key } });
}

import { Router } from "express";
import { z } from "zod";
import { requireAdmin } from "../access.js";
import { prisma } from "../db.js";
import { getEngineStorage, setEngineStorage } from "./engine.js";
import { verifyVision, embeddingIdentity } from "./semantic-models.js";

const fail = (message: string, status = 400) => Object.assign(new Error(message), { status });
const modelInput = z.object({ channelId: z.string().uuid(), model: z.string().trim().min(1) });

async function selectedModel(input: z.infer<typeof modelInput>) {
    const channel = await prisma.modelChannel.findUnique({ where: { id: input.channelId }, include: { models: true } });
    if (!channel?.enabled || channel.apiFormat === "gemini" || !channel.models.some((item) => item.name === input.model && item.enabled && item.capability === "text")) {
        throw fail("所选文字模型或渠道不可用，请管理员在自动剪辑管理设置中重新选择");
    }
    return { channel, model: input.model };
}

export const autoVideoSettingsRouter = Router();
autoVideoSettingsRouter.use(requireAdmin);
autoVideoSettingsRouter.get("/", async (_req, res) => {
    const [settings, channels, storage] = await Promise.all([
        prisma.autoVideoSetting.findUnique({ where: { id: "default" } }),
        prisma.modelChannel.findMany({ where: { enabled: true, apiFormat: { not: "gemini" } },
            select: { id: true, name: true, apiFormat: true, models: { where: { enabled: true, capability: "text" }, select: { name: true }, orderBy: { name: "asc" } } }, orderBy: { name: "asc" } }),
        getEngineStorage().catch(() => null),
    ]);
    // 素材存储位置以剪辑引擎为事实源（文件由引擎读写），引擎不可用时回退数据库记录。
    const merged = { ...(settings ?? { channelId: null, model: null }), storageDir: storage?.dir ?? settings?.storageDir ?? null, storageDefaultDir: storage?.default_dir ?? null };
    res.json({ settings: merged, channels: channels.filter((item) => item.models.length).map((item) => ({ ...item, models: item.models.map((model) => model.name) })) });
});
autoVideoSettingsRouter.put("/", async (req, res) => {
    const input = modelInput.extend({ visionChannelId: z.string().uuid().nullable().optional(), visionModel: z.string().min(1).nullable().optional(), embedChannelId: z.string().uuid().nullable().optional(), embedModel: z.string().min(1).nullable().optional(), storageDir: z.string().trim().max(400).nullable().optional() }).parse(req.body);
    await selectedModel(input);
    for (const [channelId, model] of [[input.visionChannelId, input.visionModel], [input.embedChannelId, input.embedModel]]) {
        if (!!channelId !== !!model) throw fail("渠道与模型必须同时选择");
        if (channelId && model) await selectedModel({ channelId, model });
    }
    // 素材存储位置先下发到剪辑引擎（引擎负责建目录、持久化 config.toml），
    // 成功后再写入数据库；引擎拒绝时不落库，避免两边状态不一致。
    let storageDir: string | null | undefined;
    if (input.storageDir !== undefined) {
        const applied = await setEngineStorage(input.storageDir);
        storageDir = applied.dir;
    }
    const previous = await prisma.autoVideoSetting.findUnique({ where: { id: "default" } });
    const changedVision = input.visionChannelId !== undefined && (previous?.visionChannelId !== input.visionChannelId || previous?.visionModel !== input.visionModel);
    const data = { ...input, ...(storageDir !== undefined ? { storageDir } : {}), ...(changedVision ? { visionVerified: null } : {}) };
    const settings = await prisma.autoVideoSetting.upsert({ where: { id: "default" }, create: data, update: data });
    res.json({ settings });
});
autoVideoSettingsRouter.post("/test-vision", async (_req, res) => { await verifyVision(); res.json({ ok: true }); });
autoVideoSettingsRouter.post("/reindex", async (_req, res) => {
    const key = await embeddingIdentity();
    const rows = await prisma.localVideoMaterial.findMany({ where: { deletedAt: null, annotationSource: { not: null } }, select: { id: true, revision: true } });
    const { enqueue } = await import("./semantic-queue.js");
    for (const row of rows) await prisma.$transaction(async (tx) => {
        const job = await enqueue("index", row.id, `index:${row.id}:${row.revision}:${key}`, { revision: row.revision }, tx);
        if (job.status === "failed") await tx.autoVideoJob.update({ where: { id: job.id }, data: { status: "queued", attempts: 0, error: null, availableAt: new Date() } });
        if (job.status !== "succeeded") await tx.localVideoMaterial.updateMany({ where: { id: row.id, revision: row.revision }, data: { analysisStatus: "indexing", analysisError: null } });
    });
    res.json({ queued: rows.length });
});


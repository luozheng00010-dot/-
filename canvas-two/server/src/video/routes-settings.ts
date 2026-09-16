import { Router } from "express";
import { z } from "zod";
import { requireAdmin, requireReadyUser } from "../access.js";
import { prisma } from "../db.js";

/**
 * 自动剪辑 · 管理设置接口：管理员为拆句/匹配（chat）与打标（vision）分别指定模型渠道。
 * 读写固定单行 VideoSetting(id="default")，字段与 llm.ts 的 resolveVideoModel 消费一致；
 * 未配置时 llm.ts 自动挑选第一个可用的 OpenAI 兼容渠道。鉴权同 kb：requireReadyUser + requireAdmin。
 */

const router = Router();
router.use(requireReadyUser);

const settingsPayload = (settings: { chatChannelId: string | null; chatModel: string | null; visionChannelId: string | null; visionModel: string | null } | null) => ({
    chatChannelId: settings?.chatChannelId ?? null,
    chatModel: settings?.chatModel ?? null,
    visionChannelId: settings?.visionChannelId ?? null,
    visionModel: settings?.visionModel ?? null,
});

router.get("/admin/settings", requireAdmin, async (_req, res) => {
    const [settings, channels] = await Promise.all([
        prisma.videoSetting.findUnique({ where: { id: "default" } }),
        prisma.modelChannel.findMany({ where: { enabled: true }, include: { models: { where: { enabled: true }, orderBy: { name: "asc" } } }, orderBy: { name: "asc" } }),
    ]);
    res.json({
        settings: settingsPayload(settings),
        channels: channels
            .filter((channel) => channel.apiFormat !== "gemini")
            // 不做 capability 过滤：视觉模型的能力标记不固定（embedding/image 等命名各异），
            // llm.ts 按模型名（vl/vision/qwen-v）识别视觉模型，因此返回渠道全部启用模型
            .map((channel) => ({ id: channel.id, name: channel.name, apiFormat: channel.apiFormat, models: channel.models.map((model) => model.name) })),
    });
});

const settingsInput = z.object({
    chatChannelId: z.string().uuid().nullish(),
    chatModel: z.string().trim().max(120).nullish(),
    visionChannelId: z.string().uuid().nullish(),
    visionModel: z.string().trim().max(120).nullish(),
});

router.put("/admin/settings", requireAdmin, async (req, res) => {
    const input = settingsInput.parse(req.body);
    for (const [channelId, model] of [[input.chatChannelId, input.chatModel], [input.visionChannelId, input.visionModel]] as const) {
        if (!channelId) continue;
        const channel = await prisma.modelChannel.findUnique({ where: { id: channelId }, include: { models: true } });
        if (!channel) throw Object.assign(new Error("所选渠道不存在"), { status: 400 });
        if (model && !channel.models.some((item) => item.name === model)) throw Object.assign(new Error(`渠道 ${channel.name} 下不存在模型 ${model}`), { status: 400 });
    }
    const settings = await prisma.videoSetting.upsert({
        where: { id: "default" },
        create: { id: "default", ...input },
        update: input,
    });
    res.json({ settings: settingsPayload(settings) });
});

export default router;

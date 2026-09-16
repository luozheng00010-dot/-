import { Router } from "express";
import { z } from "zod";
import { requireReadyUser } from "../access.js";
import { prisma } from "../db.js";
import { listBgmAssets } from "./export.js";

/**
 * 自动剪辑 · 导出接口（T8 的 HTTP 侧，前端契约见 00-总体设计 §8）：
 * - POST /timelines/:id/export：建 VideoExportTask（queued），worker 进程的 export.ts 轮询消化
 * - GET /exports：导出历史（最近 50 条）
 * - GET /exports/:id：单条任务进度 / 成片 MediaFile
 * P2 起导出参数扩展（F3）：burnSubtitle / subtitleStyle（3 套预置字幕）/ bgm（曲库 id）/ bgmVolume。
 * 鉴权与风格同 routes-materials.ts：requireReadyUser。
 */

const router = Router();
router.use(requireReadyUser);

const routeParam = (value: string | string[]) => Array.isArray(value) ? value[0] : value;

/** P1 仅支持 1080x1920 竖版，其他分辨率直接 400 */
const exportInput = z.object({
    resolution: z.enum(["1080x1920"], { errorMap: () => ({ message: "目前仅支持 1080x1920 分辨率" }) }).optional(),
    /** 是否烧录字幕，默认 true */
    burnSubtitle: z.boolean({ errorMap: () => ({ message: "burnSubtitle 必须是布尔值" }) }).optional(),
    /** 字幕预置样式（F3a），默认 minimal */
    subtitleStyle: z.enum(["minimal", "highlight", "bar"], { errorMap: () => ({ message: "字幕样式只能是 minimal、highlight 或 bar" }) }).optional(),
    /** BGM 曲目 id（assets/bgm 下 mp3 去扩展名文件名）；null/缺省 = 无 BGM */
    bgm: z.string({ errorMap: () => ({ message: "BGM 必须是曲库 id 或 null" }) }).trim().min(1, "BGM id 不能为空").max(100, "BGM id 最长 100 字符").nullable().optional(),
    /** BGM 音量（0-1），默认 0.15 */
    bgmVolume: z.number({ errorMap: () => ({ message: "BGM 音量必须是 0-1 之间的数字" }) }).min(0, "BGM 音量不能小于 0").max(1, "BGM 音量不能大于 1").optional(),
});

const taskSummary = (task: { id: string; timelineId: string; status: string; progress: number; error: string | null; outputMediaId: string | null; createdAt: Date; finishedAt: Date | null }) => ({
    id: task.id,
    timelineId: task.timelineId,
    status: task.status,
    progress: task.progress,
    error: task.error,
    outputMediaId: task.outputMediaId,
    createdAt: task.createdAt,
    finishedAt: task.finishedAt,
});

router.post("/timelines/:id/export", async (req, res) => {
    const input = exportInput.parse(req.body || {});
    const timeline = await prisma.videoTimeline.findUnique({ where: { id: routeParam(req.params.id) } });
    if (!timeline) throw Object.assign(new Error("时间线不存在"), { status: 404 });
    if (input.bgm && !listBgmAssets().some((asset) => asset.id === input.bgm)) {
        throw Object.assign(new Error("BGM 不存在"), { status: 400 });
    }
    const task = await prisma.videoExportTask.create({
        data: {
            timelineId: timeline.id,
            createdById: req.user!.id,
            params: {
                resolution: input.resolution ?? "1080x1920",
                burnSubtitle: input.burnSubtitle ?? true,
                subtitleStyle: input.subtitleStyle ?? "minimal",
                bgm: input.bgm ?? null,
                bgmVolume: input.bgmVolume ?? 0.15,
            },
            status: "queued",
        },
    });
    res.status(202).json({ task: taskSummary(task) });
});

router.get("/exports", async (_req, res) => {
    const tasks = await prisma.videoExportTask.findMany({ orderBy: { createdAt: "desc" }, take: 50 });
    res.json({ tasks: tasks.map(taskSummary) });
});

router.get("/exports/:id", async (req, res) => {
    const task = await prisma.videoExportTask.findUnique({ where: { id: routeParam(req.params.id) } });
    if (!task) throw Object.assign(new Error("导出任务不存在"), { status: 404 });
    res.json({ task: taskSummary(task) });
});

export default router;

import { Prisma } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { requireReadyUser } from "../access.js";
import { prisma } from "../db.js";
import {
    collectSegmentViolations,
    matchTimeline,
    rematchSentence,
    timelineItemSchema,
    type GapReport,
    type SegmentMaterialInfo,
    type TimelineItem,
} from "./match.js";
import { categoryCheckError, loadCategoryNames, sentencePlanListSchema, splitSentences, type SentencePlan } from "./split.js";

/**
 * 自动剪辑 · 文案拆句与时间线接口（T6/T7 的 HTTP 层）。
 * 持久化职责：split 落 sentences + status="split"；match 每次新建一条 VideoTimeline
 * （version = 该文案现有最大 version + 1，status="matched"）。
 * 鉴权与响应风格同 routes-materials.ts（requireReadyUser）。
 */

const router = Router();
router.use(requireReadyUser);

const routeParam = (value: string | string[]) => Array.isArray(value) ? value[0] : value;
const json = (value: unknown) => value as Prisma.InputJsonValue;

function scriptDto(script: { id: string; title: string; sku: string; rawText: string; sentences: unknown; status: string }) {
    return {
        id: script.id,
        title: script.title,
        sku: script.sku,
        rawText: script.rawText,
        sentences: (script.sentences ?? null) as SentencePlan[] | null,
        status: script.status,
    };
}

function timelineDto(timeline: { id: string; scriptId: string; version: number; items: unknown; gapReport: unknown; status: string }) {
    return {
        id: timeline.id,
        scriptId: timeline.scriptId,
        version: timeline.version,
        items: (timeline.items ?? []) as TimelineItem[],
        gapReport: (timeline.gapReport ?? null) as GapReport | null,
        status: timeline.status,
    };
}

// ===== 文案 =====

const scriptCreateInput = z.object({
    title: z.string({ required_error: "请输入标题" }).trim().min(1, "请输入标题").max(100, "标题最长 100 字"),
    sku: z.string({ required_error: "请填写货号" }).trim().min(1, "请填写货号").max(100, "货号最长 100 字"),
    rawText: z.string({ required_error: "请输入文案" }).trim().min(1, "请输入文案").max(5000, "文案最长 5000 字"),
});

router.post("/scripts", async (req, res) => {
    const input = scriptCreateInput.parse(req.body || {});
    // 货号是一等数据，先建后用：文案的 sku 不可能是"通用"，直接校验存在
    const skuRow = await prisma.videoSku.findUnique({ where: { name: input.sku } });
    if (!skuRow) throw Object.assign(new Error("货号不存在，请先在下拉框中添加"), { status: 400 });
    const script = await prisma.videoScript.create({ data: { ...input, createdById: req.user!.id, status: "draft" } });
    res.status(201).json({ script: scriptDto(script) });
});

router.get("/scripts/:id", async (req, res) => {
    const script = await prisma.videoScript.findUnique({ where: { id: routeParam(req.params.id) } });
    if (!script) throw Object.assign(new Error("文案不存在"), { status: 404 });
    res.json({ script: scriptDto(script) });
});

router.post("/scripts/:id/split", async (req, res) => {
    const script = await prisma.videoScript.findUnique({ where: { id: routeParam(req.params.id) } });
    if (!script) throw Object.assign(new Error("文案不存在"), { status: 404 });
    const sentences = await splitSentences(script.rawText);
    const updated = await prisma.videoScript.update({
        where: { id: script.id },
        data: { sentences: json(sentences), status: "split" },
    });
    res.json({ script: scriptDto(updated) });
});

// ===== 匹配 =====

const matchInput = z.object({ sentences: sentencePlanListSchema.optional() });

/** 覆盖式 sentences 的分类名校验（与拆句同一套 zod schema + 数据库分类集合） */
async function assertSentencesCategories(plans: SentencePlan[]): Promise<void> {
    const error = categoryCheckError(plans, await loadCategoryNames());
    if (error) throw Object.assign(new Error(error), { status: 400 });
}

router.post("/scripts/:id/match", async (req, res) => {
    const input = matchInput.parse(req.body || {});
    const script = await prisma.videoScript.findUnique({ where: { id: routeParam(req.params.id) } });
    if (!script) throw Object.assign(new Error("文案不存在"), { status: 404 });

    let sentences = (script.sentences ?? null) as SentencePlan[] | null;
    if (input.sentences) {
        await assertSentencesCategories(input.sentences);
        sentences = input.sentences;
        await prisma.videoScript.update({ where: { id: script.id }, data: { sentences: json(sentences) } });
    }
    if (!sentences) throw Object.assign(new Error("该文案还没有拆句结果，请先执行拆句或在请求中传入 sentences"), { status: 400 });

    const { items, gapReport } = await matchTimeline({ sku: script.sku, sentences });
    const aggregate = await prisma.videoTimeline.aggregate({ where: { scriptId: script.id }, _max: { version: true } });
    const version = (aggregate?._max?.version ?? 0) + 1;
    const timeline = await prisma.videoTimeline.create({
        data: { scriptId: script.id, version, items: json(items), gapReport: json(gapReport), status: "matched" },
    });
    await prisma.videoScript.update({ where: { id: script.id }, data: { status: "matched" } });
    res.status(201).json({ timeline: timelineDto(timeline) });
});

// ===== 时间线 =====

router.get("/timelines/:id", async (req, res) => {
    const timeline = await prisma.videoTimeline.findUnique({ where: { id: routeParam(req.params.id) } });
    if (!timeline) throw Object.assign(new Error("时间线不存在"), { status: 404 });
    res.json({ timeline: timelineDto(timeline) });
});

const timelinePutInput = z.object({ items: z.array(timelineItemSchema).min(1, "至少保留一个句子").max(200, "最多 200 句") });

router.put("/timelines/:id", async (req, res) => {
    const input = timelinePutInput.parse(req.body || {});
    const timeline = await prisma.videoTimeline.findUnique({ where: { id: routeParam(req.params.id) } });
    if (!timeline) throw Object.assign(new Error("时间线不存在"), { status: 404 });
    const script = await prisma.videoScript.findUnique({ where: { id: timeline.scriptId } });
    if (!script) throw Object.assign(new Error("时间线对应的文案不存在"), { status: 404 });

    // 素材可能已被归档/打标状态变化：按当前 { status: "active", tagStatus: "done" } 查库校验
    const materialIds = [...new Set(input.items.flatMap((item) => item.segments.map((segment) => segment.materialId)))];
    const materials = materialIds.length
        ? await prisma.videoMaterial.findMany({
            where: { id: { in: materialIds }, status: "active", tagStatus: "done" },
            select: { id: true, sku: true, duration: true, category: { select: { name: true } } },
        })
        : [];
    const materialsById = new Map<string, SegmentMaterialInfo>(materials.map((material) => [material.id, {
        sku: material.sku,
        duration: material.duration,
        categoryName: material.category?.name ?? "",
    }]));
    const violations: string[] = [];
    for (const item of input.items) {
        item.segments.forEach((segment, index) => {
            violations.push(...collectSegmentViolations(`句子 ${item.sentenceId} 第 ${index + 1} 段`, item.needCategory, [segment], materialsById, null));
        });
    }
    if (violations.length) throw Object.assign(new Error(violations.slice(0, 5).join("；")), { status: 400 });

    const updated = await prisma.videoTimeline.update({
        where: { id: timeline.id },
        data: { items: json(input.items), version: timeline.version + 1, status: "edited" },
    });
    res.json({ timeline: timelineDto(updated) });
});

// ===== 单句重匹配（P2 F1） =====

const rematchInput = z.object({ sentenceId: z.number({ required_error: "请指定要重匹配的句子" }).int().min(1, "sentenceId 必须是正整数") });

router.post("/timelines/:id/rematch", async (req, res) => {
    const input = rematchInput.parse(req.body || {});
    const timeline = await prisma.videoTimeline.findUnique({ where: { id: routeParam(req.params.id) } });
    if (!timeline) throw Object.assign(new Error("时间线不存在"), { status: 404 });
    const script = await prisma.videoScript.findUnique({ where: { id: timeline.scriptId } });
    if (!script) throw Object.assign(new Error("时间线对应的文案不存在"), { status: 404 });
    const sentences = (script.sentences ?? null) as SentencePlan[] | null;
    if (!sentences) throw Object.assign(new Error("该文案还没有拆句结果，无法重匹配"), { status: 400 });
    const sentence = sentences.find((item) => item.sentenceId === input.sentenceId);
    if (!sentence) throw Object.assign(new Error(`句子 ${input.sentenceId} 不存在，请刷新后重试`), { status: 400 });

    const currentItems = ((timeline.items ?? []) as unknown) as TimelineItem[];
    const { items, gapReport } = await rematchSentence({ sku: script.sku, sentences }, sentence, currentItems);
    const updated = await prisma.videoTimeline.update({
        where: { id: timeline.id },
        data: { items: json(items), gapReport: json(gapReport), version: timeline.version + 1, status: "edited" },
    });
    res.json({ timeline: timelineDto(updated) });
});

export default router;

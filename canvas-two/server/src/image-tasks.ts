import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { accessibleOwnerIds, assertAccess, requireReadyUser } from "./access.js";
import { prisma } from "./db.js";
import { DEFAULT_DETAIL_PAGE_PROMPT, refreshProjectStatus, resolveDetailPagePairPrompt } from "./detail-pages.js";
import { mediaResponse } from "./media.js";

const router = Router();
const activeStatuses = ["queued", "running"];
const terminalStatuses = ["succeeded", "partial", "failed", "cancelled"];
const referenceInput = z.object({ mediaId: z.string().uuid(), name: z.string().max(200).default("图片"), type: z.string().max(100).default("image/png") });
const createInput = z.object({
    ownerId: z.string().uuid().optional(),
    clientRequestId: z.string().min(1).max(120),
    channelId: z.string().uuid(),
    operation: z.enum(["generation", "edit"]),
    model: z.string().min(1).max(200),
    prompt: z.string().min(1).max(50_000),
    requestPrompt: z.string().min(1).max(100_000),
    count: z.number().int().min(1).max(15),
    parameters: z.record(z.unknown()).default({}),
    references: z.array(referenceInput).max(16).default([]),
    maskMediaId: z.string().uuid().optional(),
    context: z.record(z.unknown()).optional(),
});

function routeParam(value: string | string[]) { return Array.isArray(value) ? value[0] : value; }
function json(value: unknown) { return value as Prisma.InputJsonValue; }
function productIdFromContext(context: unknown) {
    if (!context || typeof context !== "object" || Array.isArray(context)) return undefined;
    const value = context as Record<string, unknown>;
    return value.origin === "product" && typeof value.productId === "string" ? value.productId : undefined;
}
function detailPageContext(context: unknown) {
    if (!context || typeof context !== "object" || Array.isArray(context)) return undefined;
    const value = context as Record<string, unknown>;
    return value.origin === "detail-page" && typeof value.detailPageProjectId === "string" && typeof value.pairId === "string"
        ? { projectId: value.detailPageProjectId, pairId: value.pairId }
        : undefined;
}
function isSquareImageSize(value: unknown) {
    if (typeof value !== "string" || !value.trim()) return true;
    const size = value.trim();
    const dimensions = size.match(/^(\d+)x(\d+)$/i);
    if (dimensions) return dimensions[1] === dimensions[2];
    const ratio = size.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
    return Boolean(ratio && Number(ratio[1]) === Number(ratio[2]));
}
async function validateProductTask(productId: string, user: NonNullable<Express.Request["user"]>, references: Array<{ mediaId: string }>) {
    const product = await prisma.product.findUniqueOrThrow({ where: { id: productId }, include: { media: { where: { role: "source" }, select: { mediaId: true } } } });
    await assertAccess(user, product.ownerId, "edit");
    const sourceIds = new Set(product.media.map((item) => item.mediaId));
    if (!references.length || references.length !== sourceIds.size || references.some((item) => !sourceIds.has(item.mediaId))) {
        throw Object.assign(new Error("商品参考图已发生变化，请刷新商品后重新生成"), { status: 409 });
    }
    return product;
}
function ratioFor(width: number, height: number) {
    if (!width || !height) return "2:3";
    const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a;
    const divisor = gcd(width, height);
    return `${width / divisor}:${height / divisor}`;
}
async function validateDetailPageTask(context: { projectId: string; pairId: string }, user: NonNullable<Express.Request["user"]>, ownerId: string, references: Array<{ mediaId: string }>) {
    const project = await prisma.detailPageProject.findUniqueOrThrow({ where: { id: context.projectId }, include: { product: true, productMedia: true, pairs: { include: { referenceMedia: true } } } });
    await assertAccess(user, project.ownerId, "edit");
    if (project.ownerId !== ownerId) throw Object.assign(new Error("详情页任务归属账号不一致"), { status: 400 });
    const pair = project.pairs.find((item) => item.id === context.pairId);
    if (!pair) throw Object.assign(new Error("详情页配对不存在"), { status: 404 });
    if (pair.activeTaskId || activeStatuses.includes(pair.status)) throw Object.assign(new Error("该图片已有生成任务，请等待当前任务结束"), { status: 409 });
    const expected = [project.productMediaId, pair.referenceMediaId];
    if (references.length !== 2 || references.some((item, index) => item.mediaId !== expected[index])) throw Object.assign(new Error("详情页任务必须按顺序使用锁定商品图和当前参考图"), { status: 409 });
    const prompt = pair.prompt || DEFAULT_DETAIL_PAGE_PROMPT;
    return {
        project,
        pair,
        prompt,
        resolvedPrompt: resolveDetailPagePairPrompt(prompt, project.product, pair.referenceWidth, pair.referenceHeight),
        parameters: { size: ratioFor(pair.referenceWidth, pair.referenceHeight) },
        references: [
            { mediaId: project.productMediaId, name: "product-four-view.png", type: project.productMedia.mimeType },
            { mediaId: pair.referenceMediaId, name: "detail-reference.png", type: pair.referenceMedia.mimeType },
        ],
    };
}
function failedResults(task: { results: unknown; totalCount: number }, error: string) {
    const current = Array.isArray(task.results) ? task.results as Array<Record<string, unknown>> : [];
    return Array.from({ length: task.totalCount }, (_, index) => {
        const result = current.find((item) => item.index === index);
        return result?.status === "succeeded" ? result : { index, status: "failed", error };
    });
}

async function taskResponse(task: any) {
    const rawResults = Array.isArray(task.results) ? task.results : [];
    const mediaIds = rawResults.map((item: any) => item?.mediaId).filter((id: unknown): id is string => typeof id === "string");
    const media = mediaIds.length ? await prisma.mediaFile.findMany({ where: { id: { in: mediaIds } } }) : [];
    const mediaMap = new Map(media.map((item) => [item.id, item]));
    return {
        id: task.id,
        ownerId: task.ownerId,
        createdById: task.createdById,
        clientRequestId: task.clientRequestId,
        retryOfId: task.retryOfId || undefined,
        operation: task.operation,
        model: task.model,
        prompt: task.prompt,
        parameters: task.parameters,
        references: task.references,
        context: task.context || undefined,
        status: task.status,
        completedCount: task.completedCount,
        totalCount: task.totalCount,
        error: task.error || undefined,
        results: rawResults.map((result: any) => {
            const item = result.mediaId ? mediaMap.get(result.mediaId) : undefined;
            return item ? { ...result, image: { ...mediaResponse(item), dataUrl: mediaResponse(item).url, storageKey: `media:${item.id}`, width: result.width || 0, height: result.height || 0 } } : result;
        }),
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        startedAt: task.startedAt || undefined,
        completedAt: task.completedAt || undefined,
    };
}

async function loadVisibleTask(id: string, user: NonNullable<Express.Request["user"]>, edit = false) {
    const task = await prisma.imageGenerationTask.findUniqueOrThrow({ where: { id } });
    await assertAccess(user, task.ownerId, edit ? "edit" : "view");
    return task;
}

router.use(requireReadyUser);
router.post("/", async (req, res, next) => {
    try {
        const input = createInput.parse(req.body);
        const ownerId = input.ownerId || req.user!.id;
        await assertAccess(req.user!, ownerId, "edit");
        const duplicate = await prisma.imageGenerationTask.findUnique({ where: { ownerId_clientRequestId: { ownerId, clientRequestId: input.clientRequestId } } });
        if (duplicate) return res.status(200).json({ task: await taskResponse(duplicate) });
        const canvasId = typeof input.context?.canvasId === "string" ? input.context.canvasId : "";
        if (canvasId) {
            const canvas = await prisma.canvasProject.findUniqueOrThrow({ where: { id: canvasId } });
            await assertAccess(req.user!, canvas.ownerId, "edit");
        }
        const productId = productIdFromContext(input.context);
        if (productId) {
            if (input.count !== 1) throw Object.assign(new Error("商品图任务只允许生成 1 张合成图"), { status: 400 });
            if (!isSquareImageSize(input.parameters.size)) throw Object.assign(new Error("商品图任务只允许使用 1:1 输出比例"), { status: 400 });
            const product = await validateProductTask(productId, req.user!, input.references);
            if (product.ownerId !== ownerId) throw Object.assign(new Error("商品任务归属账号不一致"), { status: 400 });
            if (product.activeTaskId) throw Object.assign(new Error("该商品已有生成任务，请等待当前任务结束"), { status: 409 });
        }
        const detailContext = detailPageContext(input.context);
        let detailTask: Awaited<ReturnType<typeof validateDetailPageTask>> | undefined;
        if (detailContext) {
            if (input.count !== 1) throw Object.assign(new Error("详情页单屏任务只允许生成 1 张图片"), { status: 400 });
            detailTask = await validateDetailPageTask(detailContext, req.user!, ownerId, input.references);
        }
        const activeCount = await prisma.imageGenerationTask.count({ where: { createdById: req.user!.id, status: { in: activeStatuses } } });
        if (activeCount >= 20) throw Object.assign(new Error("当前排队或运行中的生图任务已达到 20 个，请等待任务完成后再试"), { status: 429 });
        const channel = await prisma.modelChannel.findUnique({ where: { id: input.channelId }, include: { models: true } });
        if (!channel?.enabled) throw Object.assign(new Error("管理员模型渠道不可用"), { status: 404 });
        if (!channel.models.some((model) => model.enabled && model.capability === "image" && model.name === input.model)) throw Object.assign(new Error("该渠道未启用所选图片模型"), { status: 403 });
        for (const reference of input.references) {
            const item = await prisma.mediaFile.findUniqueOrThrow({ where: { id: reference.mediaId } });
            await assertAccess(req.user!, item.ownerId, "view");
        }
        if (input.maskMediaId) {
            const mask = await prisma.mediaFile.findUniqueOrThrow({ where: { id: input.maskMediaId } });
            await assertAccess(req.user!, mask.ownerId, "view");
        }
        let task;
        try {
            task = await prisma.$transaction(async (tx) => {
                const created = await tx.imageGenerationTask.create({ data: {
                    ownerId,
                    createdById: req.user!.id,
                    channelId: input.channelId,
                    clientRequestId: input.clientRequestId,
                    operation: input.operation,
                    model: input.model,
                    prompt: detailTask?.prompt || input.prompt,
                    requestPrompt: detailTask?.resolvedPrompt || input.requestPrompt,
                    parameters: json(detailTask?.parameters || input.parameters),
                    references: json(detailTask?.references || input.references),
                    maskMediaId: input.maskMediaId,
                    context: input.context ? json(input.context) : undefined,
                    totalCount: input.count,
                    results: json(Array.from({ length: input.count }, (_, index) => ({ index, status: "queued" }))),
                } });
                if (productId) {
                    await tx.product.update({ where: { id: productId }, data: { activeTaskId: created.id, status: "queued", error: null, updatedById: req.user!.id, revision: { increment: 1 } } });
                }
                if (detailContext) {
                    const claimed = await tx.detailPagePair.updateMany({ where: { id: detailContext.pairId, revision: detailTask!.pair.revision, activeTaskId: null, status: { notIn: activeStatuses } }, data: { activeTaskId: created.id, status: "queued", error: null, resolvedPrompt: detailTask!.resolvedPrompt, revision: { increment: 1 } } });
                    if (!claimed.count) throw Object.assign(new Error("该详情页配对已被其他请求提交生成，请刷新后重试"), { status: 409 });
                    await tx.detailPageProject.update({ where: { id: detailContext.projectId }, data: { status: "generating", error: null, updatedById: req.user!.id, revision: { increment: 1 } } });
                }
                return created;
            });
        } catch (error) {
            if ((error as { code?: string }).code !== "P2002") throw error;
            const duplicate = await prisma.imageGenerationTask.findUnique({ where: { ownerId_clientRequestId: { ownerId, clientRequestId: input.clientRequestId } } });
            if (!duplicate) throw error;
            return res.status(200).json({ task: await taskResponse(duplicate) });
        }
        res.status(202).json({ task: await taskResponse(task) });
    } catch (error) { next(error); }
});

router.get("/", async (req, res, next) => {
    try {
        const ownerIds = await accessibleOwnerIds(req.user!, String(req.query.owner || "self"));
        const status = String(req.query.status || "");
        const clientRequestId = req.query.clientRequestId ? String(req.query.clientRequestId) : undefined;
        const canvasId = req.query.canvasId ? String(req.query.canvasId) : undefined;
        const tasks = await prisma.imageGenerationTask.findMany({
            where: {
                ownerId: { in: ownerIds },
                ...(status === "active" ? { status: { in: activeStatuses } } : terminalStatuses.includes(status) || activeStatuses.includes(status) ? { status } : {}),
                ...(clientRequestId ? { clientRequestId } : {}),
                ...(canvasId ? { context: { path: ["canvasId"], equals: canvasId } } : {}),
            },
            orderBy: { createdAt: "desc" },
            take: 50,
        });
        res.json({ tasks: await Promise.all(tasks.map(taskResponse)) });
    } catch (error) { next(error); }
});

router.get("/:id", async (req, res, next) => {
    try { res.json({ task: await taskResponse(await loadVisibleTask(routeParam(req.params.id), req.user!)) }); }
    catch (error) { next(error); }
});

router.post("/:id/cancel", async (req, res, next) => {
    try {
        const task = await loadVisibleTask(routeParam(req.params.id), req.user!, true);
        if (task.status !== "queued") throw Object.assign(new Error(task.status === "running" ? "任务已经开始运行，无法取消" : "当前任务无法取消"), { status: 409 });
        const productId = productIdFromContext(task.context);
        const detailContext = detailPageContext(task.context);
        await prisma.$transaction(async (tx) => {
            const result = await tx.imageGenerationTask.updateMany({ where: { id: task.id, status: "queued" }, data: { status: "cancelled", error: "任务已取消", results: json(failedResults(task, "任务已取消")), completedCount: task.totalCount, completedAt: new Date() } });
            if (!result.count) throw Object.assign(new Error("任务已经开始运行，无法取消"), { status: 409 });
            if (productId) await tx.product.updateMany({ where: { id: productId, activeTaskId: task.id }, data: { activeTaskId: null, status: "failed", error: "任务已取消", updatedById: req.user!.id, revision: { increment: 1 } } });
            if (detailContext) {
                const pairResult = await tx.detailPagePair.updateMany({ where: { id: detailContext.pairId, projectId: detailContext.projectId, activeTaskId: task.id }, data: { activeTaskId: null, status: "failed", error: "任务已取消", revision: { increment: 1 } } });
                if (!pairResult.count) throw Object.assign(new Error("详情页配对状态已变化，请刷新后重试"), { status: 409 });
            }
        });
        if (detailContext) await refreshProjectStatus(detailContext.projectId, req.user!.id);
        res.json({ task: await taskResponse(await prisma.imageGenerationTask.findUniqueOrThrow({ where: { id: task.id } })) });
    } catch (error) { next(error); }
});

router.post("/:id/retry", async (req, res, next) => {
    try {
        const source = await loadVisibleTask(routeParam(req.params.id), req.user!, true);
        if (source.status !== "failed" && source.status !== "partial") throw Object.assign(new Error("只有失败或部分失败的任务可以重试"), { status: 409 });
        const input = z.object({ clientRequestId: z.string().min(1).max(120).optional() }).parse(req.body || {});
        if (input.clientRequestId) {
            const duplicate = await prisma.imageGenerationTask.findUnique({ where: { ownerId_clientRequestId: { ownerId: source.ownerId, clientRequestId: input.clientRequestId } } });
            if (duplicate) return res.status(200).json({ task: await taskResponse(duplicate) });
        }
        const activeCount = await prisma.imageGenerationTask.count({ where: { createdById: req.user!.id, status: { in: activeStatuses } } });
        if (activeCount >= 20) throw Object.assign(new Error("当前排队或运行中的生图任务已达到 20 个，请等待任务完成后再试"), { status: 429 });
        const channel = await prisma.modelChannel.findUnique({ where: { id: source.channelId }, include: { models: true } });
        if (!channel?.enabled) throw Object.assign(new Error("管理员模型渠道不可用"), { status: 404 });
        if (!channel.models.some((model) => model.enabled && model.capability === "image" && model.name === source.model)) throw Object.assign(new Error("该渠道未启用所选图片模型"), { status: 403 });
        const references = Array.isArray(source.references) ? source.references as Array<{ mediaId?: unknown }> : [];
        for (const reference of references) {
            if (typeof reference.mediaId !== "string") continue;
            const item = await prisma.mediaFile.findUniqueOrThrow({ where: { id: reference.mediaId } });
            await assertAccess(req.user!, item.ownerId, "view");
        }
        if (source.maskMediaId) {
            const mask = await prisma.mediaFile.findUniqueOrThrow({ where: { id: source.maskMediaId } });
            await assertAccess(req.user!, mask.ownerId, "view");
        }
        const productId = productIdFromContext(source.context);
        const productReferences = references.flatMap((reference) => typeof reference.mediaId === "string" ? [{ mediaId: reference.mediaId }] : []);
        if (productId) {
            const product = await validateProductTask(productId, req.user!, productReferences);
            if (product.activeTaskId) throw Object.assign(new Error("该商品已有生成任务，请等待当前任务结束"), { status: 409 });
        }
        const detailContext = detailPageContext(source.context);
        const detailTask = detailContext ? await validateDetailPageTask(detailContext, req.user!, source.ownerId, productReferences) : undefined;
        const task = await prisma.$transaction(async (tx) => {
            const created = await tx.imageGenerationTask.create({ data: {
                ownerId: source.ownerId,
                createdById: req.user!.id,
                channelId: source.channelId,
                clientRequestId: input.clientRequestId || randomUUID(),
                retryOfId: source.id,
                operation: source.operation,
                model: source.model,
                prompt: detailTask?.prompt || source.prompt,
                requestPrompt: detailTask?.resolvedPrompt || source.requestPrompt,
                parameters: (detailTask?.parameters || source.parameters) as Prisma.InputJsonValue,
                references: (detailTask?.references || source.references) as Prisma.InputJsonValue,
                maskMediaId: source.maskMediaId,
                context: source.context as Prisma.InputJsonValue | undefined,
                totalCount: source.totalCount,
                results: json(Array.from({ length: source.totalCount }, (_, index) => ({ index, status: "queued" }))),
            } });
            if (productId) await tx.product.update({ where: { id: productId }, data: { activeTaskId: created.id, status: "queued", error: null, updatedById: req.user!.id, revision: { increment: 1 } } });
            if (detailContext) {
                const claimed = await tx.detailPagePair.updateMany({ where: { id: detailContext.pairId, revision: detailTask!.pair.revision, activeTaskId: null, status: { notIn: activeStatuses } }, data: { activeTaskId: created.id, status: "queued", error: null, resolvedPrompt: detailTask!.resolvedPrompt, revision: { increment: 1 } } });
                if (!claimed.count) throw Object.assign(new Error("该详情页配对已被其他请求提交生成，请刷新后重试"), { status: 409 });
                await tx.detailPageProject.update({ where: { id: detailContext.projectId }, data: { status: "generating", error: null, updatedById: req.user!.id, revision: { increment: 1 } } });
            }
            return created;
        });
        res.status(202).json({ task: await taskResponse(task) });
    } catch (error) { next(error); }
});

export { router as imageTaskRouter };

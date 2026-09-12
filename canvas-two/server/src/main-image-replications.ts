import { randomUUID } from "node:crypto";
import type { Prisma, User } from "@prisma/client";
import { Router } from "express";
import sharp from "sharp";
import { z } from "zod";

import { accessLevel, accessibleOwnerIds, assertAccess, requireReadyUser } from "./access.js";
import { prisma } from "./db.js";
import { mediaBuffer, mediaResponse } from "./media.js";

const router = Router();
const MAX_REFERENCES = 6;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_PROMPT_LENGTH = 100_000;
const activeStatuses = ["queued", "running"];
const json = (value: unknown) => value as Prisma.InputJsonValue;
const routeParam = (value: string | string[]) => Array.isArray(value) ? value[0] : value;
const httpError = (message: string, status: number, code?: string) => Object.assign(new Error(message), { status, code });

export const DEFAULT_MAIN_IMAGE_PROMPT = [
    "图一是我们的商品四视角主图，图二是主图复刻参考图。",
    "以图一中的商品为唯一主体，保持商品真实的外形、颜色、结构、材质、工艺、细节和用户商品自身的品牌标识。",
    "参考图只用于迁移构图、镜头、景别、文字排版、字体层级、色彩、光线、背景、装饰和整体视觉风格。",
    "不要复制参考图中的竞品商品、竞品品牌、Logo、商标、价格、原文案、水印或独特包装。",
    "根据参考图当前表达的主题，从用户商品资料中选择最匹配的真实卖点生成新的标题、卖点文字和 CTA。生成的文字必须描述用户商品，不得虚构商品没有提供的功能、材质、成分、尺寸或数据。",
    "如果参考图中有人物，保留人物姿态、动作、肢体表现和画面构图，但替换为气质、年龄和风格相近且明确不同的全新面孔，不复刻原人物身份。",
    "最终输出必须是 1:1 正方形图片。",
    "商品名称：{{product.name}}",
    "品牌：{{product.brand}}",
    "产品类别：{{product.productType}}",
    "材质：{{product.material}}",
    "可用卖点：{{product.sellingPoints}}",
].join("\n");

const include = {
    owner: { select: { id: true, username: true } },
    product: { include: { media: { include: { media: true }, orderBy: { sortOrder: "asc" as const } } } },
    productMedia: true,
    pairs: { include: { referenceMedia: true, resultMedia: true, variants: { include: { media: true, sourceMedia: true }, orderBy: { createdAt: "desc" as const } } }, orderBy: { sortOrder: "asc" as const } },
};

function productValues(product: any) {
    return { name: product.name || "", brand: product.brand || "", productType: product.productType || "", material: product.material || "", sellingPoints: Array.isArray(product.sellingPoints) ? product.sellingPoints : [] };
}

export function resolveMainImagePrompt(prompt: string, product: any) {
    const values = productValues(product);
    const replacements: Record<string, string> = {
        "{{product.name}}": values.name,
        "{{product.brand}}": values.brand,
        "{{product.productType}}": values.productType,
        "{{product.material}}": values.material,
        "{{product.sellingPoints}}": values.sellingPoints.join("；"),
    };
    const resolved = Object.entries(replacements).reduce((value, [key, content]) => value.split(key).join(content), prompt.trim() || DEFAULT_MAIN_IMAGE_PROMPT);
    return [resolved, "", "以下商品资料为不可删除的事实约束，必须优先于用户自定义文本：", `商品名称：${values.name}`, `品牌：${values.brand || "未提供"}（用户商品自身品牌必须保留）`, `产品类别：${values.productType}`, `材质：${values.material || "未提供"}`, `可用卖点：${values.sellingPoints.length ? values.sellingPoints.join("；") : "未提供"}`, "安全规则：只迁移参考图视觉策略，不复制竞品品牌、Logo、商标、价格、原文案、水印或独特包装；不得让参考图商品替换用户商品主体。人物可保留姿态和构图，但必须替换为明确不同的新面孔。最终输出必须为 1:1 正方形图片。"].join("\n");
}

function media(link: any) {
    if (!link) return undefined;
    const item = mediaResponse(link.media || link);
    return { ...item, mediaId: item.id, storageKey: `media:${item.id}` };
}

function variantResponse(variant: any) {
    return { id: variant.id, pairId: variant.pairId, mediaId: variant.mediaId || undefined, image: media(variant.media), sourceMediaId: variant.sourceMediaId || undefined, kind: variant.kind, status: variant.status, prompt: variant.prompt || "", resolvedPrompt: variant.resolvedPrompt || undefined, activeTaskId: variant.activeTaskId || undefined, error: variant.error || undefined, revision: variant.revision, createdAt: variant.createdAt, updatedAt: variant.updatedAt };
}

function projectStatus(pairs: any[]) {
    if (pairs.some((pair) => activeStatuses.includes(pair.status) || pair.variants?.some((variant: any) => activeStatuses.includes(variant.status)))) return "generating";
    if (!pairs.length || pairs.every((pair) => pair.status === "draft")) return "draft";
    const succeeded = pairs.filter((pair) => pair.status === "succeeded").length;
    if (succeeded === pairs.length) return "succeeded";
    if (succeeded) return "partial";
    return "failed";
}

async function response(project: any, user: User) {
    const productImage = media(project.productMedia);
    return {
        id: project.id, ownerId: project.ownerId, ownerUsername: project.owner.username, title: project.title, productId: project.productId, productMediaId: project.productMediaId,
        status: projectStatus(project.pairs || []), error: project.error || undefined, revision: project.revision, defaultPrompt: DEFAULT_MAIN_IMAGE_PROMPT,
        accessLevel: await accessLevel(user, project.ownerId), createdAt: project.createdAt, updatedAt: project.updatedAt, productImage,
        product: { ...productValues(project.product), id: project.product.id, instruction: project.product.instruction || "", resultImage: productImage },
        pairs: (project.pairs || []).map((pair: any) => ({ id: pair.id, projectId: project.id, sortOrder: pair.sortOrder, referenceMediaId: pair.referenceMediaId, referenceImage: media(pair.referenceMedia), resultMediaId: pair.resultMediaId || undefined, resultImage: media(pair.resultMedia), referenceWidth: pair.referenceWidth, referenceHeight: pair.referenceHeight, prompt: pair.prompt || DEFAULT_MAIN_IMAGE_PROMPT, resolvedPrompt: pair.resolvedPrompt || undefined, status: pair.status, activeTaskId: pair.activeTaskId || undefined, error: pair.error || undefined, revision: pair.revision, modificationVariants: (pair.variants || []).map(variantResponse) })),
    };
}

async function loadProject(id: string, user: User, required: "view" | "edit") {
    const project = await prisma.mainImageReplicationProject.findUniqueOrThrow({ where: { id }, include });
    await assertAccess(user, project.ownerId, required);
    return project;
}

async function validateReferences(ids: string[], user: User, ownerId: string) {
    if (ids.length < 1 || ids.length > MAX_REFERENCES) throw httpError(`参考主图数量必须为 1-${MAX_REFERENCES} 张`, 400);
    if (new Set(ids).size !== ids.length) throw httpError("参考主图不能重复", 400);
    const items = await prisma.mediaFile.findMany({ where: { id: { in: ids } } });
    if (items.length !== ids.length) throw httpError("部分参考主图不存在", 404);
    return Promise.all(ids.map(async (id) => {
        const item = items.find((candidate) => candidate.id === id)!;
        await assertAccess(user, item.ownerId, "view");
        if (item.ownerId !== ownerId) throw httpError("参考主图必须属于商品所有者", 403);
        if (!item.mimeType.startsWith("image/")) throw httpError("参考主图必须是图片", 400);
        if (item.bytes > BigInt(MAX_IMAGE_BYTES)) throw httpError("单张参考主图不能超过 20MB", 400);
        const loaded = await mediaBuffer(item.id);
        const metadata = await sharp(loaded.buffer, { animated: false }).metadata();
        const width = metadata.width || 0;
        const height = metadata.height || 0;
        if (!width || !height) throw httpError("无法读取参考主图尺寸", 400);
        if (Math.max(width / height, height / width) > 3) throw httpError("参考主图宽高比不能超过 3:1", 400);
        return { width, height };
    }));
}

async function validateChannel(channelId: string, model: string) {
    const channel = await prisma.modelChannel.findUnique({ where: { id: channelId }, include: { models: true } });
    if (!channel?.enabled || !channel.models.some((item) => item.enabled && item.capability === "image" && item.name === model)) throw httpError("管理员图片渠道或模型不可用", 403);
}

function pairClientId(prefix: string, pairId: string) { return `${prefix}-${pairId}`.slice(0, 120); }

async function createTask(tx: any, project: any, pair: any, variant: any, input: { channelId: string; model: string; clientRequestId: string; maskMediaId?: string }, actorId: string) {
    const prompt = variant ? variant.prompt || pair.prompt : pair.prompt;
    const product = await tx.product.findUniqueOrThrow({ where: { id: project.productId } });
    const requestPrompt = resolveMainImagePrompt(prompt, product);
    const task = await tx.imageGenerationTask.create({ data: {
        ownerId: project.ownerId, createdById: actorId, channelId: input.channelId, clientRequestId: input.clientRequestId, operation: "edit", model: input.model, prompt, requestPrompt,
        parameters: json({ size: "1:1", quality: "auto", count: "1" }), references: json(variant?.kind === "mask_edit" && variant.sourceMediaId ? [{ mediaId: variant.sourceMediaId, name: "current-main-image.png", type: pair.resultMedia?.mimeType || "image/png" }] : [{ mediaId: project.productMediaId, name: "product-four-view.png", type: project.productMedia.mimeType }, { mediaId: pair.referenceMediaId, name: "main-reference.png", type: pair.referenceMedia.mimeType }]), maskMediaId: input.maskMediaId,
        context: json({ origin: "main-image-replication", mainImageProjectId: project.id, pairId: pair.id, ...(variant ? { variantId: variant.id, variantKind: variant.kind } : {}) }), results: json([{ index: 0, status: "queued" }]), totalCount: 1,
    } });
    if (variant) await tx.mainImageReplicationVariant.update({ where: { id: variant.id }, data: { activeTaskId: task.id, status: "queued", resolvedPrompt: requestPrompt, revision: { increment: 1 } } });
    else await tx.mainImageReplicationPair.update({ where: { id: pair.id }, data: { activeTaskId: task.id, status: "queued", resolvedPrompt: requestPrompt, error: null, revision: { increment: 1 } } });
    return task;
}

router.use(requireReadyUser);
router.use((_req, _res, next) => {
    const client = prisma as unknown as { mainImageReplicationProject?: unknown; mainImageReplicationPair?: unknown; mainImageReplicationVariant?: unknown };
    if (!client.mainImageReplicationProject || !client.mainImageReplicationPair || !client.mainImageReplicationVariant) return next(httpError("1:1主图复刻服务未完成初始化，请重启开发服务", 503, "MAIN_IMAGE_CLIENT_NOT_GENERATED"));
    next();
});

router.get("/", async (req, res, next) => {
    try {
        const ownerIds = await accessibleOwnerIds(req.user!, String(req.query.owner || "self"));
        const keyword = String(req.query.keyword || "").trim().slice(0, 100);
        const page = Math.max(1, Number(req.query.page) || 1);
        const pageSize = Math.max(1, Math.min(50, Number(req.query.pageSize) || 20));
        const where = { ownerId: { in: ownerIds }, ...(keyword ? { OR: [{ title: { contains: keyword, mode: "insensitive" as const } }, { product: { name: { contains: keyword, mode: "insensitive" as const } } }] } : {}) };
        const [total, items] = await Promise.all([prisma.mainImageReplicationProject.count({ where }), prisma.mainImageReplicationProject.findMany({ where, include, orderBy: { updatedAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize })]);
        res.json({ items: await Promise.all(items.map((item) => response(item, req.user!))), total, page, pageSize });
    } catch (error) { next(error); }
});

router.get("/:id", async (req, res, next) => { try { res.json({ item: await response(await loadProject(routeParam(req.params.id), req.user!, "view"), req.user!) }); } catch (error) { next(error); } });

router.post("/", async (req, res, next) => {
    try {
        const input = z.object({ productId: z.string().uuid(), title: z.string().trim().max(200).optional(), referenceMediaIds: z.array(z.string().uuid()).min(1).max(MAX_REFERENCES) }).parse(req.body);
        const product = await prisma.product.findUniqueOrThrow({ where: { id: input.productId }, include: { media: { include: { media: true }, orderBy: { sortOrder: "asc" } } } });
        await assertAccess(req.user!, product.ownerId, "edit");
        const result = product.media.find((item) => item.role === "result");
        if (!result) throw httpError("该商品尚未生成四视角主图，请先到商品图模块生成", 409);
        const dimensions = await validateReferences(input.referenceMediaIds, req.user!, product.ownerId);
        const project = await prisma.mainImageReplicationProject.create({ data: { ownerId: product.ownerId, productId: product.id, productMediaId: result.mediaId, createdById: req.user!.id, updatedById: req.user!.id, title: input.title || `${product.name}-主图复刻`, pairs: { create: input.referenceMediaIds.map((referenceMediaId, sortOrder) => ({ referenceMediaId, sortOrder, referenceWidth: dimensions[sortOrder].width, referenceHeight: dimensions[sortOrder].height, prompt: DEFAULT_MAIN_IMAGE_PROMPT })) } }, include });
        res.status(201).json({ item: await response(project, req.user!) });
    } catch (error) { next(error); }
});

router.patch("/:id", async (req, res, next) => { try { const input = z.object({ revision: z.number().int().positive(), title: z.string().trim().min(1).max(200) }).parse(req.body); const project = await loadProject(routeParam(req.params.id), req.user!, "edit"); const result = await prisma.mainImageReplicationProject.updateMany({ where: { id: project.id, revision: input.revision }, data: { title: input.title, updatedById: req.user!.id, revision: { increment: 1 } } }); if (!result.count) throw httpError("主图复刻项目已在其他页面更新，请刷新后重试", 409, "REVISION_CONFLICT"); res.json({ item: await response(await loadProject(project.id, req.user!, "view"), req.user!) }); } catch (error) { next(error); } });

router.patch("/:id/pairs/:pairId", async (req, res, next) => { try { const input = z.object({ revision: z.number().int().positive(), prompt: z.string().trim().min(1).max(MAX_PROMPT_LENGTH) }).parse(req.body); const project = await loadProject(routeParam(req.params.id), req.user!, "edit"); const pair = project.pairs.find((item: any) => item.id === routeParam(req.params.pairId)); if (!pair) throw httpError("主图复刻配对不存在", 404); if (pair.activeTaskId || activeStatuses.includes(pair.status)) throw httpError("该主图正在生成，不能修改提示词", 409); const result = await prisma.mainImageReplicationPair.updateMany({ where: { id: pair.id, projectId: project.id, revision: input.revision }, data: { prompt: input.prompt, resolvedPrompt: null, status: "draft", error: null, revision: { increment: 1 } } }); if (!result.count) throw httpError("主图复刻配对已在其他页面更新，请刷新后重试", 409, "REVISION_CONFLICT"); res.json({ item: await response(await loadProject(project.id, req.user!, "view"), req.user!) }); } catch (error) { next(error); } });

async function generate(req: any, res: any, next: (error: unknown) => void, pairId?: string) {
    try {
        const input = z.object({ revision: z.number().int().positive().optional(), model: z.string().trim().min(1).max(200), channelId: z.string().uuid(), clientRequestId: z.string().trim().min(1).max(120).optional(), clientRequestIdPrefix: z.string().trim().min(1).max(90).optional() }).parse(req.body);
        const project = await loadProject(routeParam(req.params.id), req.user!, "edit"); await validateChannel(input.channelId, input.model);
        const pairs = pairId ? project.pairs.filter((pair: any) => pair.id === pairId) : project.pairs.filter((pair: any) => pair.status !== "succeeded" || !pair.resultMediaId);
        if (!pairs.length) throw httpError("没有待生成的主图", 404);
        if (pairs.some((pair: any) => pair.activeTaskId || activeStatuses.includes(pair.status))) throw httpError("已有主图正在生成，请等待当前任务结束", 409);
        if (input.revision != null && (pairId ? pairs[0].revision !== input.revision : project.revision !== input.revision)) throw httpError("主图复刻项目已在其他页面更新，请刷新后重试", 409, "REVISION_CONFLICT");
        const prefix = input.clientRequestIdPrefix || input.clientRequestId || `main-image-${randomUUID()}`;
        await prisma.$transaction(async (tx) => {
            const current = await tx.mainImageReplicationProject.findUniqueOrThrow({ where: { id: project.id }, include: { pairs: true, productMedia: true } });
            if (input.revision != null && !pairId && current.revision !== input.revision) throw httpError("主图复刻项目已在其他页面更新，请刷新后重试", 409, "REVISION_CONFLICT");
            for (const [index, pair] of pairs.entries()) { const currentPair = current.pairs.find((item) => item.id === pair.id); if (!currentPair) throw httpError("主图复刻配对不存在", 404); await createTask(tx, current, currentPair, undefined, { channelId: input.channelId, model: input.model, clientRequestId: pairId ? prefix : pairClientId(prefix, currentPair.id) }, req.user!.id); }
            await tx.mainImageReplicationProject.update({ where: { id: project.id }, data: { status: "generating", error: null, updatedById: req.user!.id, revision: { increment: 1 } } });
        });
        res.status(202).json({ item: await response(await loadProject(project.id, req.user!, "view"), req.user!) });
    } catch (error) { next(error); }
}
router.post("/:id/generate", (req, res, next) => generate(req, res, next));
router.post("/:id/pairs/:pairId/generate", (req, res, next) => generate(req, res, next, routeParam(req.params.pairId)));

router.post("/:id/pairs/:pairId/cancel", async (req, res, next) => { try { const project = await loadProject(routeParam(req.params.id), req.user!, "edit"); const pair = project.pairs.find((item: any) => item.id === routeParam(req.params.pairId)); if (!pair?.activeTaskId || pair.status !== "queued") throw httpError("当前主图没有可取消的排队任务", 409); const cancelled = await prisma.imageGenerationTask.updateMany({ where: { id: pair.activeTaskId, status: "queued" }, data: { status: "cancelled", error: "任务已取消", completedCount: 1, completedAt: new Date(), results: json([{ index: 0, status: "failed", error: "任务已取消" }]) } }); if (!cancelled.count) throw httpError("任务已经开始运行，无法取消", 409); await prisma.mainImageReplicationPair.update({ where: { id: pair.id }, data: { activeTaskId: null, status: "failed", error: "任务已取消", revision: { increment: 1 } } }); res.json({ item: await response(await loadProject(project.id, req.user!, "view"), req.user!) }); } catch (error) { next(error); } });

router.post("/:id/pairs/:pairId/result", async (req, res, next) => { try { const input = z.object({ revision: z.number().int().positive(), status: z.enum(["running", "succeeded", "failed", "interrupted"]), mediaId: z.string().uuid().optional(), error: z.string().trim().max(500).optional() }).parse(req.body); const project = await loadProject(routeParam(req.params.id), req.user!, "edit"); const pair = project.pairs.find((item: any) => item.id === routeParam(req.params.pairId)); if (!pair || pair.revision !== input.revision || (pair.status !== "running" && input.status !== "running")) throw httpError("主图生成状态已变化，请刷新后重试", 409); if (input.status === "succeeded" && !input.mediaId) throw httpError("生成成功时必须提供结果图片", 400); if (input.mediaId) await assertAccess(req.user!, (await prisma.mediaFile.findUniqueOrThrow({ where: { id: input.mediaId } })).ownerId, "view"); await prisma.mainImageReplicationPair.update({ where: { id: pair.id }, data: { resultMediaId: input.mediaId || pair.resultMediaId, status: input.status, error: input.status === "failed" || input.status === "interrupted" ? input.error || "主图生成失败" : null, ...(input.status === "running" ? {} : { activeTaskId: null }), revision: { increment: 1 } } }); res.json({ item: await response(await loadProject(project.id, req.user!, "view"), req.user!) }); } catch (error) { next(error); } });

router.post("/:id/pairs/:pairId/variants", async (req, res, next) => { try { const input = z.object({ revision: z.number().int().positive(), kind: z.enum(["retry", "mask_edit"]), mode: z.enum(["remote", "personal"]).default("remote"), model: z.string().trim().min(1).max(200).optional(), channelId: z.string().uuid().optional(), sourceMediaId: z.string().uuid().optional(), maskMediaId: z.string().uuid().optional(), prompt: z.string().trim().min(1).max(MAX_PROMPT_LENGTH).optional() }).parse(req.body); const project = await loadProject(routeParam(req.params.id), req.user!, "edit"); const pair = project.pairs.find((item: any) => item.id === routeParam(req.params.pairId)); if (!pair || !pair.resultMediaId) throw httpError("首次生成请使用生成按钮，修改图需要先有正式图", 409); if (pair.variants?.some((item: any) => activeStatuses.includes(item.status))) throw httpError("当前已有修改图正在生成，请等待完成后再试", 409); if (input.kind === "mask_edit" && input.sourceMediaId !== pair.resultMediaId) throw httpError("局部编辑必须使用当前正式生成图", 409); if (input.mode === "remote" && (!input.channelId || !input.model)) throw httpError("管理员生成缺少模型渠道", 400); if (input.channelId && input.model) await validateChannel(input.channelId, input.model); const variant = await prisma.$transaction(async (tx) => { const created = await tx.mainImageReplicationVariant.create({ data: { pairId: pair.id, kind: input.kind, status: input.mode === "remote" ? "queued" : "running", prompt: input.prompt || pair.prompt, sourceMediaId: input.sourceMediaId, createdById: req.user!.id } }); if (input.mode === "remote") await createTask(tx, project, pair, created, { channelId: input.channelId!, model: input.model!, clientRequestId: `main-variant-${randomUUID()}`, maskMediaId: input.maskMediaId }, req.user!.id); return created; }); res.status(input.mode === "remote" ? 202 : 201).json({ item: await response(await loadProject(project.id, req.user!, "view"), req.user!), variantId: variant.id }); } catch (error) { next(error); } });

router.post("/:id/pairs/:pairId/variants/:variantId/result", async (req, res, next) => { try { const input = z.object({ revision: z.number().int().positive(), status: z.enum(["succeeded", "failed", "interrupted"]), mediaId: z.string().uuid().optional(), error: z.string().trim().max(500).optional() }).parse(req.body); const project = await loadProject(routeParam(req.params.id), req.user!, "edit"); const variant = project.pairs.flatMap((pair: any) => pair.variants || []).find((item: any) => item.id === routeParam(req.params.variantId)); if (!variant || variant.revision !== input.revision || variant.status !== "running") throw httpError("修改图状态已变化，请刷新后重试", 409); if (input.status === "succeeded" && !input.mediaId) throw httpError("生成成功时必须提供结果图片", 400); await prisma.mainImageReplicationVariant.update({ where: { id: variant.id }, data: { mediaId: input.mediaId, status: input.status, error: input.status === "failed" || input.status === "interrupted" ? input.error || "修改图生成失败" : null, revision: { increment: 1 } } }); res.json({ item: await response(await loadProject(project.id, req.user!, "view"), req.user!) }); } catch (error) { next(error); } });

router.post("/:id/pairs/:pairId/variants/:variantId/promote", async (req, res, next) => { try { const input = z.object({ revision: z.number().int().positive() }).parse(req.body); const project = await loadProject(routeParam(req.params.id), req.user!, "edit"); const pair = project.pairs.find((item: any) => item.id === routeParam(req.params.pairId)); const variant = pair?.variants?.find((item: any) => item.id === routeParam(req.params.variantId)); if (!pair || !variant || variant.revision !== input.revision || variant.status !== "succeeded" || !variant.mediaId) throw httpError("只能覆盖成功的修改图", 409); await prisma.$transaction(async (tx) => { await tx.$queryRaw`SELECT id FROM "main_image_replication_pairs" WHERE id = ${pair.id} FOR UPDATE`; const current = await tx.mainImageReplicationPair.findUniqueOrThrow({ where: { id: pair.id } }); if (current.revision !== pair.revision) throw httpError("主图复刻配对已在其他页面更新，请刷新后重试", 409, "REVISION_CONFLICT"); if (current.resultMediaId) await tx.mainImageReplicationVariant.create({ data: { pairId: pair.id, kind: "previous_main", status: "succeeded", mediaId: current.resultMediaId, sourceMediaId: current.resultMediaId, prompt: current.prompt, createdById: req.user!.id } }); await tx.mainImageReplicationPair.update({ where: { id: pair.id }, data: { resultMediaId: variant.mediaId, status: "succeeded", error: null, revision: { increment: 1 } } }); await tx.mainImageReplicationVariant.delete({ where: { id: variant.id } }); }); res.json({ item: await response(await loadProject(project.id, req.user!, "view"), req.user!) }); } catch (error) { next(error); } });

router.post("/:id/pairs/:pairId/variants/:variantId/cancel", async (req, res, next) => { try { const project = await loadProject(routeParam(req.params.id), req.user!, "edit"); const variant = project.pairs.flatMap((pair: any) => pair.variants || []).find((item: any) => item.id === routeParam(req.params.variantId)); if (!variant?.activeTaskId || variant.status !== "queued") throw httpError("当前修改图没有可取消的排队任务", 409); const task = await prisma.imageGenerationTask.updateMany({ where: { id: variant.activeTaskId, status: "queued" }, data: { status: "cancelled", error: "任务已取消", completedCount: 1, completedAt: new Date(), results: json([{ index: 0, status: "failed", error: "任务已取消" }]) } }); if (!task.count) throw httpError("任务已经开始运行，无法取消", 409); await prisma.mainImageReplicationVariant.update({ where: { id: variant.id }, data: { activeTaskId: null, status: "failed", error: "任务已取消", revision: { increment: 1 } } }); res.json({ item: await response(await loadProject(project.id, req.user!, "view"), req.user!) }); } catch (error) { next(error); } });

router.delete("/:id/pairs/:pairId/variants/:variantId", async (req, res, next) => { try { const project = await loadProject(routeParam(req.params.id), req.user!, "edit"); const pair = project.pairs.find((item: any) => item.id === routeParam(req.params.pairId)); const variant = pair?.variants?.find((item: any) => item.id === routeParam(req.params.variantId)); if (!variant) throw httpError("修改图版本不存在", 404); if (variant.status === "queued" || variant.status === "running") throw httpError("排队或生成中的修改图不能删除", 409); await prisma.mainImageReplicationVariant.delete({ where: { id: variant.id } }); res.status(204).end(); } catch (error) { next(error); } });

router.delete("/:id", async (req, res, next) => { try { const project = await loadProject(routeParam(req.params.id), req.user!, "edit"); await prisma.mainImageReplicationProject.delete({ where: { id: project.id } }); res.status(204).end(); } catch (error) { next(error); } });

export function mainImageReplicationContext(context: unknown) {
    if (!context || typeof context !== "object" || Array.isArray(context)) return undefined;
    const value = context as Record<string, unknown>;
    return value.origin === "main-image-replication" && typeof value.mainImageProjectId === "string" && typeof value.pairId === "string" ? { projectId: value.mainImageProjectId, pairId: value.pairId, variantId: typeof value.variantId === "string" ? value.variantId : undefined } : undefined;
}

export async function markMainImageReplicationRunning(task: any) {
    const context = mainImageReplicationContext(task.context); if (!context) return;
    await prisma.$transaction(async (tx) => { await tx.$queryRaw`SELECT id FROM "main_image_replication_projects" WHERE id = ${context.projectId} FOR UPDATE`; if (context.variantId) await tx.mainImageReplicationVariant.updateMany({ where: { id: context.variantId, pairId: context.pairId, activeTaskId: task.id }, data: { status: "running", error: null, revision: { increment: 1 } } }); else await tx.mainImageReplicationPair.updateMany({ where: { id: context.pairId, projectId: context.projectId, activeTaskId: task.id }, data: { status: "running", error: null, revision: { increment: 1 } } }); });
}

export async function saveMainImageReplicationResult(task: any, results: Array<{ index: number; status: string; mediaId?: string; error?: string }>, status: string, error?: string | null) {
    const context = mainImageReplicationContext(task.context); if (!context) return true;
    const success = results.find((item) => item.status === "succeeded" && item.mediaId); let accepted = false;
    await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "main_image_replication_projects" WHERE id = ${context.projectId} FOR UPDATE`;
        const taskUpdated = await tx.imageGenerationTask.updateMany({ where: { id: task.id, status: "running" }, data: { status: success ? "succeeded" : status, results: json(results), completedCount: task.totalCount, error: success ? null : error, completedAt: new Date(), heartbeatAt: new Date() } });
        if (!taskUpdated.count) return;
        if (context.variantId) { const variant = await tx.mainImageReplicationVariant.findFirst({ where: { id: context.variantId, pairId: context.pairId, activeTaskId: task.id } }); if (!variant) return; await tx.mainImageReplicationVariant.update({ where: { id: variant.id }, data: { activeTaskId: null, mediaId: success?.mediaId || null, status: success ? "succeeded" : "failed", error: success ? null : error || "修改图生成失败", revision: { increment: 1 } } }); accepted = true; return; }
        const pair = await tx.mainImageReplicationPair.findFirst({ where: { id: context.pairId, projectId: context.projectId, activeTaskId: task.id } }); if (!pair) return;
        await tx.mainImageReplicationPair.update({ where: { id: pair.id }, data: { activeTaskId: null, resultMediaId: success?.mediaId || null, status: success ? "succeeded" : "failed", error: success ? null : error || "主图生成失败", revision: { increment: 1 } } });
        const pairs = await tx.mainImageReplicationPair.findMany({ where: { projectId: context.projectId }, select: { status: true } }); const nextStatus = pairs.some((item) => activeStatuses.includes(item.status)) ? "generating" : pairs.every((item) => item.status === "succeeded") ? "succeeded" : pairs.some((item) => item.status === "succeeded") ? "partial" : "failed";
        await tx.mainImageReplicationProject.update({ where: { id: context.projectId }, data: { status: nextStatus, error: nextStatus === "failed" ? error || "主图生成失败" : null, updatedById: task.createdById, revision: { increment: 1 } } }); accepted = true;
    });
    return accepted;
}

export default router;

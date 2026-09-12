import { randomUUID } from "node:crypto";
import type { Prisma, User } from "@prisma/client";
import { Router } from "express";
import sharp from "sharp";
import { z } from "zod";

import { accessLevel, accessibleOwnerIds, assertAccess, requireReadyUser } from "./access.js";
import { prisma } from "./db.js";
import { mediaBuffer, mediaResponse } from "./media.js";
import { removeObject } from "./storage.js";

const router = Router();
const MAX_REFERENCES = 18;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_PROMPT_LENGTH = 100_000;
const activeStatuses = ["queued", "running"];
const LEGACY_DETAIL_PAGE_PERSON_RULE = "不要复制参考图中的竞品品牌、Logo、商标、价格、原文案、水印、人物或模特身份；用户商品自身品牌必须保留。";
const DETAIL_PAGE_PERSON_RULE = "不要复制参考图中的竞品品牌、Logo、商标、价格、原文案或水印；如果参考图中有人物，保持人物的姿态、动作、肢体表现、服装展示关系和画面构图，但不要复制原人物的身份。如果参考图中只出现人物的部分肢体，保留这些可见的人物部分肢体、姿态和构图，不补全未出现的身体部分。将人物脸替换为气质、年龄和风格相近但明确不同的全新面孔，不要复刻或还原任何具体个人；用户商品自身品牌必须保留。";
const RESULT_RETRY_RULE = "图一是我们的商品四视角主图，图二是当前正式生成图。以商品图为唯一主体，参考当前生成图的构图、排版和视觉风格重新生成，优化当前结果并保留商品真实外形、材质、卖点和自身品牌。";
const GENERATION_RESOLUTIONS = ["1k", "2k", "4k"] as const;
const GENERATION_ASPECTS = ["original", "1:1", "3:2", "2:3", "16:9", "9:16", "4:3", "3:4", "21:9"] as const;
const GENERATION_QUALITIES = ["auto", "low", "medium", "high"] as const;

export const DEFAULT_DETAIL_PAGE_PROMPT = [
    "图一是我们的产品图，图二是我们要复刻的详情页参考图片。",
    "以图一中的商品为唯一主体，保持商品的真实外形、颜色、结构、材质、细节和品牌标识。",
    "保持参考图的文字排版、信息层级、构图、字体风格、色彩、光线、背景、装饰和整体视觉风格，但不要复制参考图中的竞品商品。",
    "根据用户商品资料和参考图当前表达的主题，选择最匹配的真实卖点生成新的标题、卖点文字。文字必须描述用户商品，不得虚构商品没有提供的功能、材质、成分或数据。",
    DETAIL_PAGE_PERSON_RULE,
    "品牌：{{product.brand}}",
    "材质：{{product.material}}",
    "可用卖点：{{product.sellingPoints}}",
].join("\n");

const projectInclude = {
    owner: { select: { id: true, username: true } },
    product: { include: { media: { include: { media: true }, orderBy: { sortOrder: "asc" as const } } } },
    productMedia: true,
    pairs: { include: { referenceMedia: true, resultMedia: true, references: { include: { media: true }, orderBy: { sortOrder: "asc" as const } }, variants: { include: { media: true, sourceMedia: true }, orderBy: { createdAt: "desc" as const } } }, orderBy: { sortOrder: "asc" as const } },
};

const routeParam = (value: string | string[]) => Array.isArray(value) ? value[0] : value;
const json = (value: unknown) => value as Prisma.InputJsonValue;
const httpError = (message: string, status: number, code?: string) => Object.assign(new Error(message), { status, code });

function normalizeDetailPagePrompt(prompt: string) {
    return prompt.trim().replace(LEGACY_DETAIL_PAGE_PERSON_RULE, DETAIL_PAGE_PERSON_RULE).replace(/(?:^|\n)商品名称：\{\{product\.name\}\}(?=\n|$)/g, "").replace(/\{\{product\.name\}\}/g, "").trim() || DEFAULT_DETAIL_PAGE_PROMPT;
}

function productSnapshot(product: any) {
    return {
        id: product.id,
        name: product.name,
        brand: product.brand || "",
        productType: product.productType || "",
        material: product.material || "",
        sellingPoints: Array.isArray(product.sellingPoints) ? product.sellingPoints : [],
        instruction: product.instruction || "",
    };
}

export function resolveDetailPagePrompt(prompt: string, product: any) {
    const values = productSnapshot(product);
    const replacements: Record<string, string> = {
        "{{product.brand}}": values.brand,
        "{{product.productType}}": values.productType,
        "{{product.material}}": values.material,
        "{{product.sellingPoints}}": values.sellingPoints.join("；"),
    };
    const template = normalizeDetailPagePrompt(prompt);
    const resolved = Object.entries(replacements).reduce((value, [key, content]) => value.split(key).join(content), template);
    return [
        resolved,
        "",
        "以下商品资料为不可删除的事实约束，必须优先于用户自定义文本：",
        `品牌：${values.brand || "未提供"}（不得删除、遮盖或替换用户商品自身品牌）`,
        `产品类别：${values.productType}`,
        `材质：${values.material || "未提供"}`,
        `可用卖点：${values.sellingPoints.length ? values.sellingPoints.join("；") : "未提供"}`,
        "安全规则：只迁移参考图的视觉排版和风格；不得让竞品商品替换主体，不得复制竞品品牌、Logo、商标、价格、原文案或水印。参考图中有人物时，保留姿态、动作、肢体表现和画面构图；如果只出现人物部分肢体，保留这些可见部分肢体，不补全未出现的身体部分；但必须替换为气质、年龄和风格相近且明确不同的全新面孔，不得复刻或还原原人物身份；不得生成与任何具体个人相同的脸。用户商品自身品牌必须保留。",
    ].join("\n");
}

function image(link: any) {
    if (!link) return undefined;
    const item = mediaResponse(link.media || link);
    return { ...item, mediaId: item.id, storageKey: `media:${item.id}` };
}

function pairReferenceResponse(pair: any) {
    const refs = Array.isArray(pair.references) ? pair.references.map((item: any) => ({ id: item.id, mediaId: item.mediaId, kind: item.kind || "upload", selected: item.selected !== false, sortOrder: item.sortOrder, image: image(item.media) })).filter((item: any) => item.image) : [];
    if (!refs.some((item: any) => item.kind === "original")) refs.unshift({ id: `original-${pair.id}`, mediaId: pair.referenceMediaId, kind: "original", selected: true, sortOrder: -1, image: image(pair.referenceMedia) });
    if (pair.resultMediaId && pair.resultMedia && !refs.some((item: any) => item.kind === "result")) refs.push({ id: `result-${pair.id}`, mediaId: pair.resultMediaId, kind: "result", selected: true, sortOrder: refs.length, image: image(pair.resultMedia) });
    return refs.sort((a: any, b: any) => a.sortOrder - b.sortOrder);
}

function variantResponse(variant: any) {
    return {
        id: variant.id,
        pairId: variant.pairId,
        mediaId: variant.mediaId || undefined,
        image: image(variant.media),
        sourceMediaId: variant.sourceMediaId || undefined,
        kind: variant.kind,
        status: variant.status,
        prompt: variant.prompt || "",
        resolvedPrompt: variant.resolvedPrompt || undefined,
        activeTaskId: variant.activeTaskId || undefined,
        error: variant.error || undefined,
        revision: variant.revision,
        createdAt: variant.createdAt,
        updatedAt: variant.updatedAt,
    };
}

function statusFromPairs(pairs: any[]) {
    if (pairs.some((pair) => activeStatuses.includes(pair.status))) return "generating";
    if (!pairs.length || pairs.every((pair) => pair.status === "draft")) return "draft";
    const succeeded = pairs.filter((pair) => pair.status === "succeeded").length;
    const failed = pairs.filter((pair) => pair.status === "failed" || pair.status === "interrupted").length;
    if (succeeded === pairs.length) return "succeeded";
    if (succeeded > 0) return "partial";
    if (failed === pairs.length) return "failed";
    return "partial";
}

async function response(project: any, user: User) {
    const pairs = Array.isArray(project.pairs) ? project.pairs : [];
    const productImage = image(project.productMedia);
    return {
        id: project.id,
        ownerId: project.ownerId,
        ownerUsername: project.owner.username,
        title: project.title,
        productId: project.productId,
        productMediaId: project.productMediaId,
        status: statusFromPairs(pairs),
        error: project.error || undefined,
        revision: project.revision,
        defaultPrompt: DEFAULT_DETAIL_PAGE_PROMPT,
        promptVariables: ["product.brand", "product.productType", "product.material", "product.sellingPoints"],
        accessLevel: await accessLevel(user, project.ownerId),
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        productImage,
        product: { ...productSnapshot(project.product), resultImage: productImage },
        pairs: pairs.map((pair: any) => ({
            id: pair.id,
            projectId: project.id,
            sortOrder: pair.sortOrder,
            referenceMediaId: pair.referenceMediaId,
            referenceImage: image(pair.referenceMedia),
            resultMediaId: pair.resultMediaId || undefined,
            resultImage: image(pair.resultMedia),
            referenceWidth: pair.referenceWidth,
            referenceHeight: pair.referenceHeight,
            prompt: normalizeDetailPagePrompt(pair.prompt),
            defaultPrompt: DEFAULT_DETAIL_PAGE_PROMPT,
            resolvedPrompt: pair.resolvedPrompt || undefined,
            generationModel: pair.generationModel || undefined,
            generationChannelId: pair.generationChannelId || undefined,
            generationResolution: pair.generationResolution || "1k",
            generationAspectRatio: pair.generationAspectRatio || "original",
            generationQuality: pair.generationQuality || "auto",
            status: pair.status,
            activeTaskId: pair.activeTaskId || undefined,
            error: pair.error || undefined,
            revision: pair.revision,
            updatedAt: pair.updatedAt,
            modificationVariants: (pair.variants || []).map(variantResponse),
            references: pairReferenceResponse(pair),
        })),
    };
}

async function loadProject(id: string, user: User, required: "view" | "edit") {
    const project = await prisma.detailPageProject.findUniqueOrThrow({ where: { id }, include: projectInclude });
    await assertAccess(user, project.ownerId, required);
    return project;
}

async function validateReferences(ids: string[], user: User, ownerId: string) {
    if (ids.length < 1 || ids.length > MAX_REFERENCES) throw httpError(`参考详情页图片数量必须为 1-${MAX_REFERENCES} 张`, 400);
    if (new Set(ids).size !== ids.length) throw httpError("参考详情页图片不能重复", 400);
    const items = await prisma.mediaFile.findMany({ where: { id: { in: ids } } });
    if (items.length !== ids.length) throw httpError("部分参考详情页图片不存在", 404);
    const dimensions: Array<{ width: number; height: number }> = [];
    for (const id of ids) {
        const item = items.find((candidate) => candidate.id === id)!;
        await assertAccess(user, item.ownerId, "view");
        if (item.ownerId !== ownerId) throw httpError("参考详情页图片必须属于商品所有者", 403);
        if (!item.mimeType.startsWith("image/")) throw httpError("参考详情页文件必须是图片", 400);
        if (item.bytes > BigInt(MAX_IMAGE_BYTES)) throw httpError("单张参考详情页图片不能超过 20MB", 400);
        let metadata: { width?: number; height?: number };
        try {
            const loaded = await mediaBuffer(item.id);
            metadata = await sharp(loaded.buffer, { animated: false }).metadata();
        } catch {
            throw httpError("无法读取参考详情页图片内容，请重新上传", 400);
        }
        const width = metadata.width || 0;
        const height = metadata.height || 0;
        if (!width || !height) throw httpError("无法读取参考详情页图片尺寸", 400);
        if (Math.max(width / height, height / width) > 3) throw httpError("参考详情页图片宽高比不能超过 3:1，请先拆分成长图", 400);
        dimensions.push({ width, height });
    }
    return dimensions;
}

function ratioFor(width: number, height: number) {
    if (!width || !height) return "2:3";
    const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a;
    const divisor = gcd(width, height);
    return `${width / divisor}:${height / divisor}`;
}

export function resolveDetailPagePairPrompt(prompt: string, product: any, width: number, height: number, outputRatio?: string) {
    return [
        resolveDetailPagePrompt(prompt, product),
        `输出图片的画布宽高比必须与目标配置保持一致，目标宽高比为 ${outputRatio || ratioFor(width, height)}。`,
    ].join("\n");
}

async function validateChannel(channelId: string, model: string) {
    const channel = await prisma.modelChannel.findUnique({ where: { id: channelId }, include: { models: true } });
    if (!channel?.enabled || !channel.models.some((item) => item.enabled && item.capability === "image" && item.name === model)) throw httpError("管理员图片渠道或模型不可用", 403);
}

function taskReferences(project: any, pair: any, sourceMediaId?: string, variantKind?: string) {
    if (sourceMediaId && variantKind === "mask_edit") return [{ mediaId: sourceMediaId, name: "detail-result.png", type: pair.resultMedia?.mimeType || "image/png" }];
    if (sourceMediaId && variantKind === "result_retry") {
        const refs = Array.isArray(pair.references) ? pair.references.filter((item: any) => item.selected !== false).sort((a: any, b: any) => a.sortOrder - b.sortOrder) : [];
        if (!refs.some((item: any) => item.mediaId === sourceMediaId)) refs.push({ mediaId: sourceMediaId, kind: "result", media: pair.resultMedia, sortOrder: 999 });
        return [{ mediaId: project.productMediaId, name: "product-four-view.png", type: project.productMedia.mimeType }, ...refs.map((item: any, index: number) => ({ mediaId: item.mediaId, name: item.kind === "result" ? "detail-result.png" : item.kind === "original" ? "detail-reference.png" : `detail-reference-${index + 1}.png`, type: item.media?.mimeType || "image/png" }))];
    }
    const refs = Array.isArray(pair.references) ? pair.references.filter((item: any) => item.selected !== false).sort((a: any, b: any) => a.sortOrder - b.sortOrder) : [];
    const selected = refs.length ? refs : [{ mediaId: pair.referenceMediaId, kind: "original", media: pair.referenceMedia }];
    return [{ mediaId: project.productMediaId, name: "product-four-view.png", type: project.productMedia.mimeType }, ...selected.map((item: any, index: number) => ({ mediaId: item.mediaId, name: item.kind === "result" ? "detail-result.png" : item.kind === "original" ? "detail-reference.png" : `detail-reference-${index + 1}.png`, type: item.media?.mimeType || "image/png" }))];
}

function generationRatio(pair: any, aspect?: string) {
    if (!aspect || aspect === "original") return ratioFor(pair.referenceWidth, pair.referenceHeight);
    return aspect;
}

function generationPixelSize(pair: any, resolution: string, aspect: string) {
    const base = resolution === "4k" ? 2880 : resolution === "2k" ? 2048 : 1024;
    const ratioText = generationRatio(pair, aspect);
    const [rw, rh] = ratioText.split(":").map(Number);
    const ratio = Math.max(1 / 3, Math.min(3, rw / Math.max(1, rh)));
    const landscape = ratio >= 1;
    const longRatio = landscape ? ratio : 1 / ratio;
    let longSide = Math.floor(Math.sqrt(base * base * longRatio) / 16) * 16;
    if (longSide > 3840) longSide = 3840;
    const shortSide = Math.max(16, Math.round(longSide / longRatio / 16) * 16);
    return landscape ? `${longSide}x${shortSide}` : `${shortSide}x${longSide}`;
}

function generationConfig(input: any, pair: any) {
    const resolution = GENERATION_RESOLUTIONS.includes(input.generationResolution) ? input.generationResolution : (pair.generationResolution || "1k");
    const aspectRatio = GENERATION_ASPECTS.includes(input.generationAspectRatio) ? input.generationAspectRatio : (pair.generationAspectRatio || "original");
    const quality = GENERATION_QUALITIES.includes(input.generationQuality) ? input.generationQuality : (pair.generationQuality || "auto");
    return { resolution, aspectRatio, quality, size: generationPixelSize(pair, resolution, aspectRatio) };
}

async function createVariantTask(tx: any, project: any, pair: any, variant: any, input: { channelId: string; model: string; clientRequestId: string; revision: number; maskMediaId?: string }, actorId: string) {
    const duplicate = await tx.imageGenerationTask.findUnique({ where: { ownerId_clientRequestId: { ownerId: project.ownerId, clientRequestId: input.clientRequestId } } });
    if (duplicate) return duplicate;
    const product = await tx.product.findUniqueOrThrow({ where: { id: project.productId } });
    const prompt = `${variant.kind === "result_retry" ? `${RESULT_RETRY_RULE}\n` : ""}${normalizeDetailPagePrompt(variant.prompt || pair.prompt)}${variant.kind === "mask_edit" ? "\n只修改蒙版透明区域，其他区域保持不变。" : ""}`;
    const config = generationConfig(pair, pair);
    const resolvedPrompt = resolveDetailPagePairPrompt(prompt, product, pair.referenceWidth, pair.referenceHeight, config.aspectRatio === "original" ? ratioFor(pair.referenceWidth, pair.referenceHeight) : config.aspectRatio);
    const task = await tx.imageGenerationTask.create({ data: {
        ownerId: project.ownerId, createdById: actorId, channelId: input.channelId, clientRequestId: input.clientRequestId,
        operation: "edit", model: input.model, prompt, requestPrompt: resolvedPrompt,
        parameters: json({ size: config.size, quality: config.quality, resolution: config.resolution }),
        references: json(taskReferences(project, pair, variant.sourceMediaId, variant.kind)), maskMediaId: input.maskMediaId,
        context: json({ origin: "detail-page", detailPageProjectId: project.id, pairId: pair.id, variantId: variant.id, variantKind: variant.kind }),
        totalCount: 1, results: json([{ index: 0, status: "queued" }]),
    } });
    const claimed = await tx.detailPagePairVariant.updateMany({ where: { id: variant.id, revision: input.revision, activeTaskId: null }, data: { activeTaskId: task.id, status: "queued", resolvedPrompt, error: null, revision: { increment: 1 } } });
    if (!claimed.count) throw httpError("该修改图已被其他请求提交生成，请刷新后重试", 409);
    return task;
}

async function createPairTask(tx: any, project: any, pair: any, input: { channelId: string; model: string; clientRequestId: string; revision: number; generationResolution?: string; generationAspectRatio?: string; generationQuality?: string }, actorId: string) {
    const duplicate = await tx.imageGenerationTask.findUnique({ where: { ownerId_clientRequestId: { ownerId: project.ownerId, clientRequestId: input.clientRequestId } } });
    if (duplicate) {
        if (pair.activeTaskId === duplicate.id) return duplicate;
        throw httpError("该详情页生成请求已存在，请刷新后重试", 409);
    }
    const product = await tx.product.findUniqueOrThrow({ where: { id: project.productId } });
    const prompt = normalizeDetailPagePrompt(pair.prompt);
    const config = generationConfig(input, pair);
    const resolvedPrompt = resolveDetailPagePairPrompt(prompt, product, pair.referenceWidth, pair.referenceHeight, config.aspectRatio === "original" ? ratioFor(pair.referenceWidth, pair.referenceHeight) : config.aspectRatio);
    const task = await tx.imageGenerationTask.create({ data: {
        ownerId: project.ownerId,
        createdById: actorId,
        channelId: input.channelId,
        clientRequestId: input.clientRequestId,
        operation: "edit",
        model: input.model,
        prompt,
        requestPrompt: resolvedPrompt,
        parameters: json({ size: config.size, quality: config.quality, resolution: config.resolution }),
        references: json(taskReferences(project, pair)),
        context: json({ origin: "detail-page", detailPageProjectId: project.id, pairId: pair.id }),
        totalCount: 1,
        results: json([{ index: 0, status: "queued" }]),
    } });
    const claimed = await tx.detailPagePair.updateMany({ where: { id: pair.id, revision: input.revision, activeTaskId: null, status: { notIn: activeStatuses } }, data: { prompt: pair.prompt, activeTaskId: task.id, status: "queued", error: null, resolvedPrompt, generationModel: input.model, generationChannelId: input.channelId, generationResolution: config.resolution, generationAspectRatio: config.aspectRatio, generationQuality: config.quality, revision: { increment: 1 } } });
    if (!claimed.count) throw httpError("该详情页配对已被其他请求提交生成，请刷新后重试", 409);
    return task;
}

function pairRequestId(prefix: string, pairId: string, index: number) {
    const suffix = `-${pairId || index}`;
    return `${prefix.slice(0, Math.max(1, 120 - suffix.length))}${suffix}`;
}

async function refreshProjectStatus(projectId: string, actorId: string) {
    await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "detail_page_projects" WHERE id = ${projectId} FOR UPDATE`;
        const pairs = await tx.detailPagePair.findMany({ where: { projectId } });
        const status = statusFromPairs(pairs);
        await tx.detailPageProject.update({ where: { id: projectId }, data: { status, error: status === "failed" ? pairs.find((pair) => pair.error)?.error || "详情页生成失败" : null, updatedById: actorId, revision: { increment: 1 } } });
    });
}

router.use(requireReadyUser);
router.use((_req, _res, next) => {
    const client = prisma as unknown as { detailPageProject?: unknown; detailPagePair?: unknown; detailPagePairVariant?: unknown };
    if (!client.detailPageProject || !client.detailPagePair || !client.detailPagePairVariant) return next(httpError("详情页复刻模块服务未完成初始化，请重启开发服务", 503, "DETAIL_PAGE_CLIENT_NOT_GENERATED"));
    next();
});

router.get("/", async (req, res, next) => {
    try {
        const ownerIds = await accessibleOwnerIds(req.user!, String(req.query.owner || "self"));
        const keyword = String(req.query.keyword || "").trim().slice(0, 100);
        const page = Math.max(1, Number(req.query.page) || 1);
        const pageSize = Math.max(1, Math.min(50, Number(req.query.pageSize) || 20));
        const where = { ownerId: { in: ownerIds }, ...(keyword ? { OR: [{ title: { contains: keyword, mode: "insensitive" as const } }, { product: { name: { contains: keyword, mode: "insensitive" as const } } }] } : {}) };
        const [total, items] = await Promise.all([
            prisma.detailPageProject.count({ where }),
            prisma.detailPageProject.findMany({ where, include: projectInclude, orderBy: { updatedAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize }),
        ]);
        res.json({ items: await Promise.all(items.map((item) => response(item, req.user!))), total, page, pageSize });
    } catch (error) { next(error); }
});

router.get("/:id", async (req, res, next) => {
    try { res.json({ item: await response(await loadProject(routeParam(req.params.id), req.user!, "view"), req.user!) }); }
    catch (error) { next(error); }
});

router.post("/", async (req, res, next) => {
    try {
        const input = z.object({ productId: z.string().uuid(), title: z.string().trim().max(200).optional(), referenceMediaIds: z.array(z.string().uuid()).min(1).max(MAX_REFERENCES) }).parse(req.body);
        const product = await prisma.product.findUniqueOrThrow({ where: { id: input.productId }, include: { media: { include: { media: true }, orderBy: { sortOrder: "asc" } } } });
        await assertAccess(req.user!, product.ownerId, "edit");
        const result = product.media.find((item) => item.role === "result");
        if (!result) throw httpError("该商品尚未生成四视角主图，请先到商品图模块生成", 409);
        if (!result.media.mimeType.startsWith("image/")) throw httpError("该商品四视角主图不是图片，请重新生成商品图", 409);
        const dimensions = await validateReferences(input.referenceMediaIds, req.user!, product.ownerId);
        const project = await prisma.detailPageProject.create({ data: {
            ownerId: product.ownerId,
            productId: product.id,
            productMediaId: result.mediaId,
            createdById: req.user!.id,
            updatedById: req.user!.id,
            title: input.title || `${product.name}-详情页`,
            pairs: { create: input.referenceMediaIds.map((referenceMediaId, sortOrder) => ({ referenceMediaId, sortOrder, referenceWidth: dimensions[sortOrder].width, referenceHeight: dimensions[sortOrder].height, prompt: DEFAULT_DETAIL_PAGE_PROMPT, references: { create: { mediaId: referenceMediaId, kind: "original", selected: true, sortOrder: 0 } } })) },
        }, include: projectInclude });
        res.status(201).json({ item: await response(project, req.user!) });
    } catch (error) { next(error); }
});

router.patch("/:id", async (req, res, next) => {
    try {
        const input = z.object({ revision: z.number().int().positive(), title: z.string().trim().min(1).max(200) }).parse(req.body);
        const project = await loadProject(routeParam(req.params.id), req.user!, "edit");
        const updated = await prisma.detailPageProject.updateMany({ where: { id: project.id, revision: input.revision }, data: { title: input.title, updatedById: req.user!.id, revision: { increment: 1 } } });
        if (!updated.count) throw httpError("详情页项目已在其他页面更新，请刷新后重试", 409, "REVISION_CONFLICT");
        res.json({ item: await response(await loadProject(project.id, req.user!, "view"), req.user!) });
    } catch (error) { next(error); }
});

router.patch("/:id/pairs/:pairId", async (req, res, next) => {
    try {
        const input = z.object({ revision: z.number().int().positive(), prompt: z.string().trim().min(1).max(MAX_PROMPT_LENGTH), generationModel: z.string().trim().max(200).optional(), generationChannelId: z.string().trim().max(200).optional(), generationResolution: z.enum(GENERATION_RESOLUTIONS).optional(), generationAspectRatio: z.enum(GENERATION_ASPECTS).optional(), generationQuality: z.enum(GENERATION_QUALITIES).optional() }).parse(req.body);
        const project = await loadProject(routeParam(req.params.id), req.user!, "edit");
        const pair = project.pairs.find((item: any) => item.id === routeParam(req.params.pairId));
        if (!pair) throw httpError("详情页配对不存在", 404);
        if (pair.activeTaskId || activeStatuses.includes(pair.status)) throw httpError("该图片正在生成，不能修改提示词", 409);
        const updated = await prisma.detailPagePair.updateMany({ where: { id: pair.id, projectId: project.id, revision: input.revision }, data: { prompt: input.prompt, resolvedPrompt: null, ...(input.generationModel === undefined ? {} : { generationModel: input.generationModel || null }), ...(input.generationChannelId === undefined ? {} : { generationChannelId: input.generationChannelId || null }), ...(input.generationResolution === undefined ? {} : { generationResolution: input.generationResolution }), ...(input.generationAspectRatio === undefined ? {} : { generationAspectRatio: input.generationAspectRatio }), ...(input.generationQuality === undefined ? {} : { generationQuality: input.generationQuality }), status: "draft", error: null, revision: { increment: 1 } } });
        if (!updated.count) throw httpError("详情页配对已在其他页面更新，请刷新后重试", 409, "REVISION_CONFLICT");
        await prisma.detailPageProject.update({ where: { id: project.id }, data: { status: "draft", error: null, updatedById: req.user!.id, revision: { increment: 1 } } });
        res.json({ item: await response(await loadProject(project.id, req.user!, "view"), req.user!) });
    } catch (error) { next(error); }
});

router.post("/:id/pairs/:pairId/references", async (req, res, next) => {
    try {
        const input = z.object({ revision: z.number().int().positive(), mediaId: z.string().uuid(), kind: z.enum(["original", "result", "upload"]).default("upload") }).parse(req.body);
        const project = await loadProject(routeParam(req.params.id), req.user!, "edit");
        const pair = project.pairs.find((item: any) => item.id === routeParam(req.params.pairId));
        if (!pair) throw httpError("详情页配对不存在", 404);
        if (pair.activeTaskId || activeStatuses.includes(pair.status)) throw httpError("图片正在生成，不能修改参考素材", 409);
        const media = await prisma.mediaFile.findUnique({ where: { id: input.mediaId } });
        if (!media) throw httpError("参考素材不存在", 404);
        await assertAccess(req.user!, media.ownerId, "view");
        if (media.ownerId !== project.ownerId || !media.mimeType.startsWith("image/") || media.bytes > BigInt(MAX_IMAGE_BYTES)) throw httpError("参考素材不符合详情页要求", 400);
        const existing = (pair as any).references?.find((item: any) => item.mediaId === input.mediaId);
        if (existing) {
            await prisma.detailPagePairReference.update({ where: { id: existing.id }, data: { selected: true } });
        } else {
            const uploadCount = ((pair as any).references || []).filter((item: any) => item.kind === "upload").length;
            if (input.kind === "upload" && uploadCount >= 8) throw httpError("每个配对最多添加 8 张上传参考图", 400);
            const maxOrder = Math.max(-1, ...((pair as any).references || []).map((item: any) => item.sortOrder));
            await prisma.detailPagePairReference.create({ data: { pairId: pair.id, mediaId: input.mediaId, kind: input.kind, selected: true, sortOrder: maxOrder + 1 } });
        }
        await prisma.$transaction([
            prisma.detailPagePair.update({ where: { id: pair.id }, data: { revision: { increment: 1 }, status: "draft", resolvedPrompt: null } }),
            prisma.detailPageProject.update({ where: { id: project.id }, data: { revision: { increment: 1 }, status: "draft", updatedById: req.user!.id } }),
        ]);
        res.json({ item: await response(await loadProject(project.id, req.user!, "view"), req.user!) });
    } catch (error) { next(error); }
});

router.patch("/:id/pairs/:pairId/references/:referenceId", async (req, res, next) => {
    try {
        const input = z.object({ revision: z.number().int().positive(), selected: z.boolean().optional(), sortOrder: z.number().int().min(0).optional() }).parse(req.body);
        const project = await loadProject(routeParam(req.params.id), req.user!, "edit");
        const pair = project.pairs.find((item: any) => item.id === routeParam(req.params.pairId));
        const reference = (pair as any)?.references?.find((item: any) => item.id === routeParam(req.params.referenceId));
        if (!pair || !reference) throw httpError("参考素材不存在", 404);
        if (pair.revision !== input.revision || pair.activeTaskId || activeStatuses.includes(pair.status)) throw httpError("参考素材状态已变化，请刷新后重试", 409, "REVISION_CONFLICT");
        await prisma.detailPagePairReference.update({ where: { id: reference.id }, data: { ...(input.selected == null ? {} : { selected: input.selected }), ...(input.sortOrder == null ? {} : { sortOrder: input.sortOrder }) } });
        await prisma.$transaction([
            prisma.detailPagePair.update({ where: { id: pair.id }, data: { revision: { increment: 1 }, status: "draft", resolvedPrompt: null } }),
            prisma.detailPageProject.update({ where: { id: project.id }, data: { revision: { increment: 1 }, status: "draft", updatedById: req.user!.id } }),
        ]);
        res.json({ item: await response(await loadProject(project.id, req.user!, "view"), req.user!) });
    } catch (error) { next(error); }
});

router.delete("/:id/pairs/:pairId/references/:referenceId", async (req, res, next) => {
    try {
        const input = z.object({ revision: z.number().int().positive() }).parse(req.body || {});
        const project = await loadProject(routeParam(req.params.id), req.user!, "edit");
        const pair = project.pairs.find((item: any) => item.id === routeParam(req.params.pairId));
        const reference = (pair as any)?.references?.find((item: any) => item.id === routeParam(req.params.referenceId));
        if (!pair || !reference) throw httpError("参考素材不存在", 404);
        if (pair.revision !== input.revision || pair.activeTaskId || activeStatuses.includes(pair.status)) throw httpError("参考素材状态已变化，请刷新后重试", 409, "REVISION_CONFLICT");
        if (reference.kind === "upload") await prisma.detailPagePairReference.delete({ where: { id: reference.id } });
        else await prisma.detailPagePairReference.update({ where: { id: reference.id }, data: { selected: false } });
        await prisma.$transaction([
            prisma.detailPagePair.update({ where: { id: pair.id }, data: { revision: { increment: 1 }, status: "draft", resolvedPrompt: null } }),
            prisma.detailPageProject.update({ where: { id: project.id }, data: { revision: { increment: 1 }, status: "draft", updatedById: req.user!.id } }),
        ]);
        res.json({ item: await response(await loadProject(project.id, req.user!, "view"), req.user!) });
    } catch (error) { next(error); }
});

async function generate(req: any, res: any, next: (error: unknown) => void, pairId?: string) {
    try {
        const input = z.object({ revision: z.number().int().positive().optional(), model: z.string().trim().min(1).max(200), channelId: z.string().uuid(), clientRequestId: z.string().trim().min(1).max(120).optional(), clientRequestIdPrefix: z.string().trim().min(1).max(90).optional(), prompt: z.string().trim().min(1).max(MAX_PROMPT_LENGTH).optional(), generationResolution: z.enum(GENERATION_RESOLUTIONS).optional(), generationAspectRatio: z.enum(GENERATION_ASPECTS).optional(), generationQuality: z.enum(GENERATION_QUALITIES).optional() }).parse(req.body);
        const project = await loadProject(routeParam(req.params.id), req.user!, "edit");
        await validateChannel(input.channelId, input.model);
        const pairs = pairId
            ? project.pairs.filter((pair: any) => pair.id === pairId)
            : project.pairs.filter((pair: any) => pair.status !== "succeeded" || !pair.resultMediaId);
        if (!pairs.length) throw httpError("详情页配对不存在", 404);
        if (input.revision != null && (pairId ? pairs[0].revision !== input.revision : project.revision !== input.revision)) throw httpError("详情页项目已在其他页面更新，请刷新后重试", 409, "REVISION_CONFLICT");
        if (pairs.some((pair: any) => pair.activeTaskId || activeStatuses.includes(pair.status))) throw httpError("已有详情页图片正在生成，请等待当前任务结束", 409);
        const prefix = input.clientRequestIdPrefix || input.clientRequestId || `detail-${randomUUID()}`;
        try {
            await prisma.$transaction(async (tx) => {
                await tx.$queryRaw`SELECT id FROM "detail_page_projects" WHERE id = ${project.id} FOR UPDATE`;
                const currentProject = await tx.detailPageProject.findUniqueOrThrow({ where: { id: project.id }, select: { revision: true } });
                if (input.revision != null && (pairId ? pairs[0].revision !== input.revision : currentProject.revision !== input.revision)) {
                    throw httpError("详情页项目已在其他页面更新，请刷新后重试", 409, "REVISION_CONFLICT");
                }
                const activeCount = await tx.imageGenerationTask.count({ where: { createdById: req.user!.id, status: { in: activeStatuses } } });
                if (activeCount + pairs.length > 20) throw httpError("当前排队或运行中的生图任务将超过 20 个，请等待任务完成后再试", 429);
                for (const [index, pair] of pairs.entries()) {
                    const clientRequestId = pairId ? prefix : pairRequestId(prefix, pair.id, index);
                    const currentPair = await tx.detailPagePair.findUniqueOrThrow({ where: { id: pair.id }, include: { referenceMedia: true, references: { include: { media: true } } } });
                    if (pairId && input.revision != null && currentPair.revision !== input.revision) {
                        throw httpError("详情页配对已在其他页面更新，请刷新后重试", 409, "REVISION_CONFLICT");
                    }
                    await createPairTask(tx, project, { ...pair, ...currentPair, ...(input.prompt ? { prompt: input.prompt } : {}) }, { channelId: input.channelId, model: input.model, clientRequestId, revision: currentPair.revision, generationResolution: input.generationResolution, generationAspectRatio: input.generationAspectRatio, generationQuality: input.generationQuality }, req.user!.id);
                }
                const updated = await tx.detailPageProject.updateMany({ where: { id: project.id, ...(pairId ? {} : { revision: project.revision }) }, data: { status: "generating", error: null, updatedById: req.user!.id, revision: { increment: 1 } } });
                if (!updated.count) throw httpError("详情页项目已在其他页面更新，请刷新后重试", 409, "REVISION_CONFLICT");
            }, { isolationLevel: "Serializable" });
        } catch (error) {
            if ((error as { code?: string }).code === "P2034") throw httpError("详情页生成请求发生并发冲突，请刷新后重试", 409, "REVISION_CONFLICT");
            throw error;
        }
        res.status(202).json({ item: await response(await loadProject(project.id, req.user!, "view"), req.user!) });
    } catch (error) { next(error); }
}

router.post("/:id/generate", (req, res, next) => generate(req, res, next));
router.post("/:id/pairs/:pairId/generate", (req, res, next) => generate(req, res, next, routeParam(req.params.pairId)));

router.post("/:id/pairs/:pairId/variants", async (req, res, next) => {
    try {
        const input = z.object({
            revision: z.number().int().positive(), kind: z.enum(["retry", "result_retry", "mask_edit"]), mode: z.enum(["remote", "personal"]).default("remote"),
            model: z.string().trim().min(1).max(200).optional(), channelId: z.string().uuid().optional(), sourceMediaId: z.string().uuid().optional(), maskMediaId: z.string().uuid().optional(),
            prompt: z.string().trim().min(1).max(MAX_PROMPT_LENGTH).optional(), clientRequestId: z.string().trim().min(1).max(120).optional(),
        }).parse(req.body);
        const project = await loadProject(routeParam(req.params.id), req.user!, "edit");
        const pair = project.pairs.find((item: any) => item.id === routeParam(req.params.pairId));
        if (!pair) throw httpError("详情页配对不存在", 404);
        if (!pair.resultMediaId) throw httpError("首次生成请使用生成按钮，修改图需要先有正式生成图", 409);
        if (pair.variants?.some((item: any) => activeStatuses.includes(item.status))) throw httpError("当前已有修改图正在生成，请等待完成后再试", 409);
        if (input.kind === "mask_edit" && input.sourceMediaId !== pair.resultMediaId) throw httpError("局部编辑必须使用当前正式生成图", 409);
        if (input.kind === "result_retry" && input.sourceMediaId !== pair.resultMediaId) throw httpError("按生成图重试必须使用当前正式生成图", 409);
        if (input.kind === "mask_edit" && !input.maskMediaId && input.mode === "remote") throw httpError("局部编辑缺少蒙版", 400);
        if (input.mode === "remote") {
            if (!input.channelId || !input.model) throw httpError("管理员生成缺少模型渠道", 400);
            await validateChannel(input.channelId, input.model);
        }
        for (const mediaId of [input.sourceMediaId, input.maskMediaId].filter(Boolean) as string[]) {
            const media = await prisma.mediaFile.findUnique({ where: { id: mediaId } });
            if (!media) throw httpError("修改图输入媒体不存在", 404);
            await assertAccess(req.user!, media.ownerId, "view");
        }
        const clientRequestId = input.clientRequestId || `detail-variant-${randomUUID()}`;
        const variant = await prisma.$transaction(async (tx) => {
            const created = await tx.detailPagePairVariant.create({ data: { pairId: pair.id, kind: input.kind, status: input.mode === "remote" ? "queued" : "running", prompt: input.prompt || normalizeDetailPagePrompt(pair.prompt), sourceMediaId: input.sourceMediaId, createdById: req.user!.id } });
            if (input.mode === "remote") {
                await createVariantTask(tx, project, { ...pair, resultMedia: pair.resultMedia }, created, { channelId: input.channelId!, model: input.model!, clientRequestId, revision: created.revision, maskMediaId: input.maskMediaId }, req.user!.id);
            }
            return created;
        });
        res.status(input.mode === "remote" ? 202 : 201).json({ item: await response(await loadProject(project.id, req.user!, "view"), req.user!), variantId: variant.id });
    } catch (error) { next(error); }
});

router.post("/:id/pairs/:pairId/variants/:variantId/result", async (req, res, next) => {
    try {
        const input = z.object({ revision: z.number().int().positive(), status: z.enum(["succeeded", "failed", "interrupted"]), mediaId: z.string().uuid().optional(), error: z.string().trim().max(500).optional() }).superRefine((value, context) => { if (value.status === "succeeded" && !value.mediaId) context.addIssue({ code: z.ZodIssueCode.custom, message: "生成成功时必须提供结果图片" }); }).parse(req.body);
        const project = await loadProject(routeParam(req.params.id), req.user!, "edit");
        const variant = project.pairs.flatMap((pair: any) => pair.variants || []).find((item: any) => item.id === routeParam(req.params.variantId));
        if (!variant) throw httpError("修改图版本不存在", 404);
        if (variant.revision !== input.revision || variant.status !== "running") throw httpError("修改图状态已变化，请刷新后重试", 409, "REVISION_CONFLICT");
        if (input.mediaId) { const media = await prisma.mediaFile.findUniqueOrThrow({ where: { id: input.mediaId } }); await assertAccess(req.user!, media.ownerId, "view"); }
        await prisma.detailPagePairVariant.update({ where: { id: variant.id }, data: { mediaId: input.mediaId, status: input.status, error: input.status === "failed" || input.status === "interrupted" ? input.error || "修改图生成失败" : null, revision: { increment: 1 } } });
        res.json({ item: await response(await loadProject(project.id, req.user!, "view"), req.user!) });
    } catch (error) { next(error); }
});

router.post("/:id/pairs/:pairId/variants/:variantId/promote", async (req, res, next) => {
    try {
        const input = z.object({ revision: z.number().int().positive() }).parse(req.body);
        const project = await loadProject(routeParam(req.params.id), req.user!, "edit");
        const pair = project.pairs.find((item: any) => item.id === routeParam(req.params.pairId));
        const variant = pair?.variants?.find((item: any) => item.id === routeParam(req.params.variantId));
        if (!pair || !variant) throw httpError("修改图版本不存在", 404);
        if (variant.revision !== input.revision || variant.status !== "succeeded" || !variant.mediaId) throw httpError("只能覆盖成功的修改图", 409);
        await prisma.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT id FROM "detail_page_pairs" WHERE id = ${pair.id} FOR UPDATE`;
            const current = await tx.detailPagePair.findUniqueOrThrow({ where: { id: pair.id } });
            if (current.revision !== pair.revision) throw httpError("详情页配对已在其他页面更新，请刷新后重试", 409, "REVISION_CONFLICT");
            if (current.resultMediaId) await tx.detailPagePairVariant.create({ data: { pairId: pair.id, kind: "previous_main", status: "succeeded", mediaId: current.resultMediaId, prompt: current.prompt, createdById: req.user!.id, sourceMediaId: current.resultMediaId } });
            await tx.detailPagePair.update({ where: { id: pair.id }, data: { resultMediaId: variant.mediaId, status: "succeeded", error: null, revision: { increment: 1 } } });
            await tx.detailPagePairVariant.delete({ where: { id: variant.id } });
        });
        await refreshProjectStatus(project.id, req.user!.id);
        res.json({ item: await response(await loadProject(project.id, req.user!, "view"), req.user!) });
    } catch (error) { next(error); }
});

router.post("/:id/pairs/:pairId/variants/:variantId/cancel", async (req, res, next) => {
    try {
        const project = await loadProject(routeParam(req.params.id), req.user!, "edit");
        const variant = project.pairs.flatMap((pair: any) => pair.variants || []).find((item: any) => item.id === routeParam(req.params.variantId));
        if (!variant || !variant.activeTaskId || variant.status !== "queued") throw httpError("当前修改图没有可取消的排队任务", 409);
        await prisma.$transaction(async (tx) => {
            const task = await tx.imageGenerationTask.updateMany({ where: { id: variant.activeTaskId, status: "queued" }, data: { status: "cancelled", error: "任务已取消", completedCount: 1, completedAt: new Date(), results: json([{ index: 0, status: "failed", error: "任务已取消" }]) } });
            if (!task.count) throw httpError("任务已经开始运行，无法取消", 409);
            await tx.detailPagePairVariant.update({ where: { id: variant.id }, data: { activeTaskId: null, status: "failed", error: "任务已取消", revision: { increment: 1 } } });
        });
        res.json({ item: await response(await loadProject(project.id, req.user!, "view"), req.user!) });
    } catch (error) { next(error); }
});

router.delete("/:id/pairs/:pairId/variants/:variantId", async (req, res, next) => {
    try {
        const project = await loadProject(routeParam(req.params.id), req.user!, "edit");
        const pair = project.pairs.find((item: any) => item.id === routeParam(req.params.pairId));
        const variant = pair?.variants?.find((item: any) => item.id === routeParam(req.params.variantId));
        if (!pair || !variant) throw httpError("修改图版本不存在", 404);
        if (variant.status === "queued" || variant.status === "running") throw httpError("排队或生成中的修改图不能删除", 409);
        if (pair.variants?.[0]?.id === variant.id && variant.status === "succeeded") throw httpError("当前修改图不能删除，请先生成或选择其他历史版本", 409);
        if (variant.mediaId && [pair.resultMediaId, ...project.pairs.flatMap((item: any) => [item.referenceMediaId, item.resultMediaId]), ...project.pairs.flatMap((item: any) => (item.variants || []).filter((candidate: any) => candidate.id !== variant.id).flatMap((candidate: any) => [candidate.mediaId, candidate.sourceMediaId]))].includes(variant.mediaId)) throw httpError("该图片仍被详情页或其他历史版本引用，不能删除", 409);
        if (variant.mediaId) {
            const needle = variant.mediaId;
            const [tasks, assets, canvases, generations, productMedia] = await Promise.all([
                prisma.imageGenerationTask.findMany({ select: { id: true, references: true, maskMediaId: true } }),
                prisma.asset.findMany({ select: { id: true, payload: true } }),
                prisma.canvasProject.findMany({ select: { id: true, payload: true } }),
                prisma.workbenchGeneration.findMany({ select: { id: true, payload: true } }),
                prisma.productMedia.findFirst({ where: { mediaId: needle }, select: { id: true } }),
            ]);
            const includes = (value: unknown) => JSON.stringify(value ?? "").includes(needle);
            if (productMedia || tasks.some((task) => task.maskMediaId === needle || includes(task.references)) || assets.some((item) => includes(item.payload)) || canvases.some((item) => includes(item.payload)) || generations.some((item) => includes(item.payload))) throw httpError("该图片仍被商品、任务、画布或资产引用，不能删除", 409);
        }
        const media = variant.mediaId ? await prisma.mediaFile.findUnique({ where: { id: variant.mediaId }, select: { id: true, objectKey: true, thumbnailObjectKey: true } }) : null;
        if (media) {
            try { await removeObject(media.objectKey); if (media.thumbnailObjectKey) await removeObject(media.thumbnailObjectKey); }
            catch { throw httpError("图片文件清理失败，未删除历史记录，请稍后重试", 503); }
        }
        await prisma.$transaction(async (tx) => { if (media) await tx.mediaFile.delete({ where: { id: media.id } }); await tx.detailPagePairVariant.delete({ where: { id: variant.id } }); });
        res.json({ ok: true });
    } catch (error) { next(error); }
});

router.post("/:id/pairs/:pairId/result", async (req, res, next) => {
    try {
        const input = z.object({ revision: z.number().int().positive(), status: z.enum(["running", "succeeded", "failed", "interrupted"]), mediaId: z.string().uuid().optional(), prompt: z.string().trim().min(1).max(MAX_PROMPT_LENGTH).optional(), error: z.string().trim().max(500).optional(), generationAspectRatio: z.enum(GENERATION_ASPECTS).optional() }).superRefine((value, context) => {
            if (value.status === "succeeded" && !value.mediaId) context.addIssue({ code: z.ZodIssueCode.custom, message: "生成成功时必须提供结果图片" });
        }).parse(req.body);
        const project = await loadProject(routeParam(req.params.id), req.user!, "edit");
        const pair = project.pairs.find((item: any) => item.id === routeParam(req.params.pairId));
        if (!pair) throw httpError("详情页配对不存在", 404);
        if (input.revision !== pair.revision) throw httpError("详情页配对已在其他页面更新，请刷新后重试", 409, "REVISION_CONFLICT");
        if (pair.activeTaskId) throw httpError("该配对已有管理员任务，请等待任务结束", 409);
        if (input.status === "running" && activeStatuses.includes(pair.status)) throw httpError("该图片已在生成，请等待当前请求结束", 409);
        if (input.status !== "running" && pair.status !== "running") throw httpError("该图片没有可回写的浏览器生成请求，请重新生成", 409);
        if (input.mediaId) {
            const media = await prisma.mediaFile.findUniqueOrThrow({ where: { id: input.mediaId } });
            if (media.ownerId !== project.ownerId) throw httpError("结果图片必须属于商品所有者", 403);
            if (!media.mimeType.startsWith("image/")) throw httpError("生成结果必须是图片", 400);
        }
        const prompt = input.status === "running" ? normalizeDetailPagePrompt(input.prompt || pair.prompt) : normalizeDetailPagePrompt(pair.prompt);
        const pairAspect = (pair as any).generationAspectRatio || "original";
        const resolvedPrompt = input.status === "running" || !pair.resolvedPrompt ? resolveDetailPagePairPrompt(prompt, project.product, pair.referenceWidth, pair.referenceHeight, input.generationAspectRatio && input.generationAspectRatio !== "original" ? input.generationAspectRatio : pairAspect === "original" ? ratioFor(pair.referenceWidth, pair.referenceHeight) : pairAspect) : pair.resolvedPrompt;
        const updated = await prisma.detailPagePair.updateMany({
            where: { id: pair.id, projectId: project.id, revision: input.revision, activeTaskId: null, ...(input.status === "running" ? { status: { notIn: activeStatuses } } : { status: "running" }) },
            data: {
                prompt,
                resolvedPrompt,
                status: input.status,
                ...(input.status === "succeeded" ? { resultMediaId: input.mediaId } : {}),
                error: input.status === "failed" ? input.error || "详情页生成失败" : input.status === "interrupted" ? input.error || "详情页生成已中断" : null,
                revision: { increment: 1 },
            },
        });
        if (!updated.count) throw httpError("详情页配对已在其他页面更新，请刷新后重试", 409, "REVISION_CONFLICT");
        if (input.status === "succeeded" && input.mediaId) {
            await prisma.detailPagePairReference.updateMany({ where: { pairId: pair.id, kind: "result" }, data: { selected: false } });
            await prisma.detailPagePairReference.upsert({ where: { pairId_mediaId: { pairId: pair.id, mediaId: input.mediaId } }, create: { pairId: pair.id, mediaId: input.mediaId, kind: "result", selected: true, sortOrder: 999 }, update: { kind: "result", selected: true, sortOrder: 999 } });
        }
        await refreshProjectStatus(project.id, req.user!.id);
        res.json({ item: await response(await loadProject(project.id, req.user!, "view"), req.user!) });
    } catch (error) { next(error); }
});

router.post("/:id/pairs/:pairId/cancel", async (req, res, next) => {
    try {
        const input = z.object({ revision: z.number().int().positive() }).parse(req.body);
        const project = await loadProject(routeParam(req.params.id), req.user!, "edit");
        const pair = project.pairs.find((item: any) => item.id === routeParam(req.params.pairId));
        if (!pair) throw httpError("详情页配对不存在", 404);
        if (pair.revision !== input.revision) throw httpError("详情页配对已在其他页面更新，请刷新后重试", 409, "REVISION_CONFLICT");
        if (!pair.activeTaskId) throw httpError("当前配对没有可取消的排队任务", 409);
        const task = await prisma.imageGenerationTask.findUnique({ where: { id: pair.activeTaskId } });
        if (!task || task.status !== "queued") throw httpError("任务已经开始运行，无法取消", 409);
        await prisma.$transaction(async (tx) => {
            const updated = await tx.imageGenerationTask.updateMany({ where: { id: task.id, status: "queued" }, data: { status: "cancelled", error: "任务已取消", completedCount: 1, completedAt: new Date(), results: json([{ index: 0, status: "failed", error: "任务已取消" }]) } });
            if (!updated.count) throw httpError("任务已经开始运行，无法取消", 409);
            const pairUpdated = await tx.detailPagePair.updateMany({ where: { id: pair.id, activeTaskId: task.id }, data: { activeTaskId: null, status: "failed", error: "任务已取消", revision: { increment: 1 } } });
            if (!pairUpdated.count) throw httpError("详情页配对状态已变化，请刷新后重试", 409);
        });
        await refreshProjectStatus(project.id, req.user!.id);
        res.json({ item: await response(await loadProject(project.id, req.user!, "view"), req.user!) });
    } catch (error) { next(error); }
});

router.delete("/:id", async (req, res, next) => {
    try {
        const project = await loadProject(routeParam(req.params.id), req.user!, "edit");
        const input = z.object({ revision: z.number().int().positive() }).optional().parse(req.body && Object.keys(req.body).length ? req.body : undefined);
        if (input && input.revision !== project.revision) throw httpError("详情页项目已在其他页面更新，请刷新后重试", 409, "REVISION_CONFLICT");
        try {
            await prisma.$transaction(async (tx) => {
                await tx.$queryRaw`SELECT id FROM "detail_page_projects" WHERE id = ${project.id} FOR UPDATE`;
                const current = await tx.detailPageProject.findUniqueOrThrow({ where: { id: project.id }, include: { pairs: { select: { activeTaskId: true, status: true, variants: { select: { activeTaskId: true, status: true } } } } } });
                if (input && input.revision !== current.revision) throw httpError("详情页项目已在其他页面更新，请刷新后重试", 409, "REVISION_CONFLICT");
                const activeTaskIds = current.pairs.flatMap((pair) => [pair.activeTaskId, ...pair.variants.map((variant) => variant.activeTaskId)].filter((id): id is string => Boolean(id)));
                const activeTasks = activeTaskIds.length ? await tx.imageGenerationTask.findMany({ where: { id: { in: activeTaskIds } }, select: { id: true, status: true } }) : [];
                if (current.pairs.some((pair) => pair.status === "running" || pair.variants.some((variant) => variant.status === "running")) || activeTasks.some((task) => task.status === "running")) throw httpError("项目仍有正在生成的图片，请等待任务完成后再删除", 409);
                const queuedTaskIds = activeTasks.filter((task) => task.status === "queued").map((task) => task.id);
                if (queuedTaskIds.length) {
                    const cancelled = await tx.imageGenerationTask.updateMany({ where: { id: { in: queuedTaskIds }, status: "queued" }, data: { status: "cancelled", error: "详情页项目已删除", completedCount: 1, completedAt: new Date(), results: json([{ index: 0, status: "failed", error: "详情页项目已删除" }]) } });
                    if (cancelled.count !== queuedTaskIds.length) throw httpError("部分任务已开始运行，请刷新后重试", 409);
                }
                await tx.detailPageProject.delete({ where: { id: project.id } });
            }, { isolationLevel: "Serializable" });
        } catch (error) {
            if ((error as { code?: string }).code === "P2034") throw httpError("详情页项目正在处理生成请求，请刷新后重试", 409, "REVISION_CONFLICT");
            throw error;
        }
        res.json({ ok: true });
    } catch (error) { next(error); }
});

export { projectInclude as detailPageProjectInclude, productSnapshot, refreshProjectStatus, router as detailPageRouter };

import type { User } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";

import { accessLevel, accessibleOwnerIds, assertAccess, requireReadyUser } from "./access.js";
import { prisma } from "./db.js";
import { mediaResponse } from "./media.js";

const router = Router();
const ownerSelect = { id: true, username: true } as const;
const actorSelect = { id: true, username: true } as const;
const productInclude = {
    owner: { select: ownerSelect },
    createdBy: { select: actorSelect },
    updatedBy: { select: actorSelect },
    media: { include: { media: true }, orderBy: { sortOrder: "asc" as const } },
};
const sourceMediaIdsInput = z.array(z.string().uuid()).min(1).max(8);
const sellingPointsInput = z.array(z.string().trim().min(1).max(80)).max(50).transform((items) => [...new Set(items)]);
const productFields = {
    name: z.string().trim().min(1, "请输入商品名称").max(100),
    brand: z.string().trim().max(100).default(""),
    productType: z.string().trim().min(1, "请输入产品").max(100),
    sellingPoints: sellingPointsInput.default([]),
    material: z.string().trim().max(500).default(""),
    instruction: z.string().trim().max(2_000).default(""),
    sourceMediaIds: sourceMediaIdsInput,
};

function productClientNotGenerated() {
    return Object.assign(new Error("商品图模块服务未完成初始化，请重启开发服务"), { status: 503, code: "PRODUCT_CLIENT_NOT_GENERATED" });
}

function routeParam(value: string | string[]) {
    return Array.isArray(value) ? value[0] : value;
}

async function loadProduct(id: string, user: User, required: "view" | "edit") {
    const product = await prisma.product.findUniqueOrThrow({ where: { id }, include: productInclude });
    await assertAccess(user, product.ownerId, required);
    return product;
}

async function validateSourceMedia(ids: string[], user: User) {
    if (new Set(ids).size !== ids.length) throw Object.assign(new Error("商品参考图不能重复"), { status: 400 });
    const items = await prisma.mediaFile.findMany({ where: { id: { in: ids } } });
    if (items.length !== ids.length) throw Object.assign(new Error("部分商品参考图不存在"), { status: 404 });
    for (const item of items) {
        await assertAccess(user, item.ownerId, "view");
        if (!item.mimeType.startsWith("image/")) throw Object.assign(new Error("商品参考文件必须是图片"), { status: 400 });
    }
}

function imageResponse(link: any) {
    const item = mediaResponse(link.media);
    return {
        id: link.id,
        mediaId: item.id,
        role: link.role,
        sortOrder: link.sortOrder,
        fileName: item.fileName,
        mimeType: item.mimeType,
        bytes: item.bytes,
        url: item.url,
        thumbnailUrl: item.thumbnailUrl || item.url,
        storageKey: `media:${item.id}`,
    };
}

async function productResponse(product: any, user: User) {
    const media = product.media.map(imageResponse);
    return {
        id: product.id,
        name: product.name,
        brand: product.brand,
        productType: product.productType,
        sellingPoints: product.sellingPoints,
        material: product.material,
        instruction: product.instruction,
        status: product.status,
        error: product.error || undefined,
        activeTaskId: product.activeTaskId || undefined,
        revision: product.revision,
        ownerId: product.ownerId,
        ownerUsername: product.owner.username,
        createdByUsername: product.createdBy.username,
        updatedByUsername: product.updatedBy.username,
        accessLevel: await accessLevel(user, product.ownerId),
        sourceImages: media.filter((item: any) => item.role === "source"),
        resultImage: media.find((item: any) => item.role === "result"),
        createdAt: product.createdAt,
        updatedAt: product.updatedAt,
    };
}

router.use(requireReadyUser);
router.use((_req, _res, next) => {
    if (!(prisma as unknown as { product?: unknown }).product) return next(productClientNotGenerated());
    next();
});

router.get("/", async (req, res, next) => {
    try {
        const ownerIds = await accessibleOwnerIds(req.user!, String(req.query.owner || "self"));
        const keyword = String(req.query.keyword || "").trim().slice(0, 100);
        const page = Math.max(1, Number(req.query.page) || 1);
        const pageSize = Math.max(1, Math.min(50, Number(req.query.pageSize) || 24));
        const where = { ownerId: { in: ownerIds }, ...(keyword ? { name: { contains: keyword, mode: "insensitive" as const } } : {}) };
        const [total, items] = await Promise.all([
            prisma.product.count({ where }),
            prisma.product.findMany({ where, include: productInclude, orderBy: { updatedAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize }),
        ]);
        res.json({ items: await Promise.all(items.map((item) => productResponse(item, req.user!))), total, page, pageSize });
    } catch (error) {
        next(error);
    }
});

router.get("/:id", async (req, res, next) => {
    try {
        res.json({ item: await productResponse(await loadProduct(routeParam(req.params.id), req.user!, "view"), req.user!) });
    } catch (error) {
        next(error);
    }
});

router.post("/", async (req, res, next) => {
    try {
        const input = z.object({ ownerId: z.string().uuid().optional(), ...productFields }).parse(req.body);
        const ownerId = input.ownerId || req.user!.id;
        await assertAccess(req.user!, ownerId, "edit");
        await validateSourceMedia(input.sourceMediaIds, req.user!);
        const product = await prisma.product.create({
            data: {
                ownerId,
                createdById: req.user!.id,
                updatedById: req.user!.id,
                name: input.name,
                brand: input.brand,
                productType: input.productType,
                sellingPoints: input.sellingPoints,
                material: input.material,
                instruction: input.instruction,
                media: { create: input.sourceMediaIds.map((mediaId, sortOrder) => ({ mediaId, role: "source", sortOrder })) },
            },
            include: productInclude,
        });
        res.status(201).json({ item: await productResponse(product, req.user!) });
    } catch (error) {
        next(error);
    }
});

router.patch("/:id", async (req, res, next) => {
    try {
        const input = z.object({
            revision: z.number().int().positive(),
            name: productFields.name.optional(),
            brand: productFields.brand.optional(),
            productType: productFields.productType.optional(),
            sellingPoints: sellingPointsInput.optional(),
            material: productFields.material.optional(),
            instruction: productFields.instruction.optional(),
            sourceMediaIds: sourceMediaIdsInput.optional(),
        }).parse(req.body);
        const current = await loadProduct(routeParam(req.params.id), req.user!, "edit");
        if (input.sourceMediaIds) await validateSourceMedia(input.sourceMediaIds, req.user!);
        await prisma.$transaction(async (tx) => {
            const updated = await tx.product.updateMany({
                where: { id: current.id, revision: input.revision },
                data: {
                    ...(input.name !== undefined ? { name: input.name } : {}),
                    ...(input.brand !== undefined ? { brand: input.brand } : {}),
                    ...(input.productType !== undefined ? { productType: input.productType } : {}),
                    ...(input.sellingPoints !== undefined ? { sellingPoints: input.sellingPoints } : {}),
                    ...(input.material !== undefined ? { material: input.material } : {}),
                    ...(input.instruction !== undefined ? { instruction: input.instruction } : {}),
                    updatedById: req.user!.id,
                    revision: { increment: 1 },
                },
            });
            if (!updated.count) throw Object.assign(new Error("商品已在其他页面更新，请刷新后重试"), { status: 409, code: "REVISION_CONFLICT" });
            if (input.sourceMediaIds) {
                await tx.productMedia.deleteMany({ where: { productId: current.id, role: "source" } });
                await tx.productMedia.createMany({ data: input.sourceMediaIds.map((mediaId, sortOrder) => ({ productId: current.id, mediaId, role: "source", sortOrder })) });
            }
        });
        res.json({ item: await productResponse(await prisma.product.findUniqueOrThrow({ where: { id: current.id }, include: productInclude }), req.user!) });
    } catch (error) {
        next(error);
    }
});

router.post("/:id/result", async (req, res, next) => {
    try {
        const input = z.object({
            status: z.enum(["running", "succeeded", "failed"]),
            mediaId: z.string().uuid().optional(),
            error: z.string().trim().max(500).optional(),
        }).superRefine((value, context) => {
            if (value.status === "succeeded" && !value.mediaId) context.addIssue({ code: z.ZodIssueCode.custom, message: "生成成功时必须提供结果图片" });
        }).parse(req.body);
        const current = await loadProduct(routeParam(req.params.id), req.user!, "edit");
        if (input.status === "running" && current.activeTaskId) {
            throw Object.assign(new Error("该商品已有生成任务，请等待当前任务结束"), { status: 409 });
        }
        if (input.mediaId) await validateSourceMedia([input.mediaId], req.user!);
        await prisma.$transaction(async (tx) => {
            if (input.status === "succeeded" && input.mediaId) {
                await tx.productMedia.deleteMany({ where: { productId: current.id, role: "result" } });
                await tx.productMedia.create({ data: { productId: current.id, mediaId: input.mediaId, role: "result", sortOrder: 0 } });
            }
            await tx.product.update({
                where: { id: current.id },
                data: {
                    status: input.status,
                    error: input.status === "failed" ? input.error || "商品图生成失败" : null,
                    activeTaskId: null,
                    updatedById: req.user!.id,
                    revision: { increment: 1 },
                },
            });
        });
        res.json({ item: await productResponse(await prisma.product.findUniqueOrThrow({ where: { id: current.id }, include: productInclude }), req.user!) });
    } catch (error) {
        next(error);
    }
});

router.delete("/:id", async (req, res, next) => {
    try {
        const current = await loadProduct(routeParam(req.params.id), req.user!, "edit");
        if (!(prisma as unknown as { detailPageProject?: unknown }).detailPageProject) throw Object.assign(new Error("详情页复刻模块服务未完成初始化，请重启开发服务"), { status: 503, code: "DETAIL_PAGE_CLIENT_NOT_GENERATED" });
        const detailPageCount = await prisma.detailPageProject.count({ where: { productId: current.id } });
        if (detailPageCount) throw Object.assign(new Error("该商品已绑定详情页复刻项目，请先删除详情页项目后再删除商品"), { status: 409 });
        await prisma.product.delete({ where: { id: current.id } });
        res.json({ ok: true });
    } catch (error) {
        next(error);
    }
});

export { productInclude, productResponse, router as productRouter };

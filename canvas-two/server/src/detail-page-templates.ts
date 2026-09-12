import type { User } from "@prisma/client";
import { Router } from "express";
import sharp from "sharp";
import { z } from "zod";

import { accessLevel, accessibleOwnerIds, assertAccess, requireReadyUser } from "./access.js";
import { prisma } from "./db.js";
import { mediaBuffer, mediaResponse } from "./media.js";

const router = Router();
const MAX_REFERENCES = 18;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const templateInclude = {
    owner: { select: { id: true, username: true } },
    references: { include: { media: true }, orderBy: { sortOrder: "asc" as const } },
};
const routeParam = (value: string | string[]) => Array.isArray(value) ? value[0] : value;
const httpError = (message: string, status: number, code?: string) => Object.assign(new Error(message), { status, code });

function image(media: any) {
    if (!media) return undefined;
    const item = mediaResponse(media);
    return { ...item, mediaId: item.id, storageKey: `media:${item.id}` };
}

function response(template: any, access: "view" | "edit" | null) {
    const references = (template.references || []).map((reference: any) => ({
        id: reference.id,
        mediaId: reference.mediaId,
        sortOrder: reference.sortOrder,
        image: image(reference.media),
        createdAt: reference.createdAt,
    }));
    return {
        id: template.id,
        ownerId: template.ownerId,
        ownerUsername: template.owner.username,
        name: template.name,
        revision: template.revision,
        coverImage: references[0]?.image,
        references,
        referenceCount: references.length,
        accessLevel: access,
        createdAt: template.createdAt,
        updatedAt: template.updatedAt,
    };
}

async function loadTemplate(id: string, user: User, required: "view" | "edit") {
    const template = await prisma.detailPageTemplate.findUniqueOrThrow({ where: { id }, include: templateInclude });
    await assertAccess(user, template.ownerId, required);
    return template;
}

async function validateReferences(ids: string[], user: User, ownerId: string) {
    if (ids.length < 1 || ids.length > MAX_REFERENCES) throw httpError(`详情页模板参考图数量必须为 1-${MAX_REFERENCES} 张`, 400);
    if (new Set(ids).size !== ids.length) throw httpError("详情页模板参考图不能重复", 400);
    const items = await prisma.mediaFile.findMany({ where: { id: { in: ids } } });
    if (items.length !== ids.length) throw httpError("部分模板参考图不存在", 404);
    for (const id of ids) {
        const item = items.find((candidate) => candidate.id === id)!;
        await assertAccess(user, item.ownerId, "view");
        if (item.ownerId !== ownerId) throw httpError("模板参考图必须属于模板所属成员", 403);
        if (!item.mimeType.startsWith("image/")) throw httpError("模板参考文件必须是图片", 400);
        if (item.bytes > BigInt(MAX_IMAGE_BYTES)) throw httpError("单张模板参考图不能超过 20MB", 400);
        try {
            const loaded = await mediaBuffer(item.id);
            const metadata = await sharp(loaded.buffer, { animated: false }).metadata();
            const width = metadata.width || 0;
            const height = metadata.height || 0;
            if (!width || !height) throw new Error("invalid dimensions");
            if (Math.max(width / height, height / width) > 3) throw httpError("模板参考图宽高比不能超过 3:1，请先拆分成长图", 400);
        } catch (error) {
            if ((error as { status?: number }).status) throw error;
            throw httpError("无法读取模板参考图内容，请重新上传", 400);
        }
    }
}

router.use(requireReadyUser);
router.use((_req, _res, next) => {
    const client = prisma as unknown as { detailPageTemplate?: unknown; detailPageTemplateReference?: unknown };
    if (!client.detailPageTemplate || !client.detailPageTemplateReference) return next(httpError("详情页模板模块服务未完成初始化，请重启开发服务", 503, "DETAIL_PAGE_TEMPLATE_CLIENT_NOT_GENERATED"));
    next();
});

router.get("/", async (req, res, next) => {
    try {
        const ownerIds = await accessibleOwnerIds(req.user!, String(req.query.owner || "self"));
        const keyword = String(req.query.keyword || "").trim().slice(0, 120);
        const page = Math.max(1, Number(req.query.page) || 1);
        const pageSize = Math.max(1, Math.min(50, Number(req.query.pageSize) || 24));
        const where = { ownerId: { in: ownerIds }, ...(keyword ? { name: { contains: keyword, mode: "insensitive" as const } } : {}) };
        const [total, templates] = await Promise.all([
            prisma.detailPageTemplate.count({ where }),
            prisma.detailPageTemplate.findMany({ where, include: templateInclude, orderBy: { updatedAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize }),
        ]);
        res.json({ items: await Promise.all(templates.map(async (template) => response(template, await accessLevel(req.user!, template.ownerId)))), total, page, pageSize });
    } catch (error) { next(error); }
});

router.get("/:id", async (req, res, next) => {
    try {
        const template = await loadTemplate(routeParam(req.params.id), req.user!, "view");
        res.json({ item: response(template, await accessLevel(req.user!, template.ownerId)) });
    } catch (error) { next(error); }
});

router.post("/", async (req, res, next) => {
    try {
        const input = z.object({ ownerId: z.string().uuid().optional(), name: z.string().trim().min(1).max(120), referenceMediaIds: z.array(z.string().uuid()).min(1).max(MAX_REFERENCES) }).parse(req.body);
        const ownerId = input.ownerId || req.user!.id;
        await assertAccess(req.user!, ownerId, "edit");
        await validateReferences(input.referenceMediaIds, req.user!, ownerId);
        const template = await prisma.detailPageTemplate.create({ data: {
            ownerId, createdById: req.user!.id, updatedById: req.user!.id, name: input.name,
            references: { create: input.referenceMediaIds.map((mediaId, sortOrder) => ({ mediaId, sortOrder })) },
        }, include: templateInclude });
        res.status(201).json({ item: response(template, "edit") });
    } catch (error) {
        if ((error as { code?: string }).code === "P2002") return next(httpError("该成员下已存在同名详情页模板", 409));
        next(error);
    }
});

router.patch("/:id", async (req, res, next) => {
    try {
        const input = z.object({ revision: z.number().int().positive(), name: z.string().trim().min(1).max(120).optional(), referenceMediaIds: z.array(z.string().uuid()).min(1).max(MAX_REFERENCES).optional() }).refine((value) => value.name !== undefined || value.referenceMediaIds !== undefined, "至少修改模板名称或参考图").parse(req.body);
        const template = await loadTemplate(routeParam(req.params.id), req.user!, "edit");
        if (input.referenceMediaIds) await validateReferences(input.referenceMediaIds, req.user!, template.ownerId);
        const updated = await prisma.$transaction(async (tx) => {
            const claimed = await tx.detailPageTemplate.updateMany({ where: { id: template.id, revision: input.revision }, data: { ...(input.name !== undefined ? { name: input.name } : {}), updatedById: req.user!.id, revision: { increment: 1 } } });
            if (!claimed.count) throw httpError("详情页模板已在其他页面更新，请刷新后重试", 409, "REVISION_CONFLICT");
            if (input.referenceMediaIds) {
                await tx.detailPageTemplateReference.deleteMany({ where: { templateId: template.id } });
                await tx.detailPageTemplateReference.createMany({ data: input.referenceMediaIds.map((mediaId, sortOrder) => ({ templateId: template.id, mediaId, sortOrder })) });
            }
            return tx.detailPageTemplate.findUniqueOrThrow({ where: { id: template.id }, include: templateInclude });
        });
        res.json({ item: response(updated, "edit") });
    } catch (error) {
        if ((error as { code?: string }).code === "P2002") return next(httpError("该成员下已存在同名详情页模板", 409));
        next(error);
    }
});

router.delete("/:id", async (req, res, next) => {
    try {
        const input = z.object({ revision: z.number().int().positive() }).optional().parse(req.body && Object.keys(req.body).length ? req.body : undefined);
        const template = await loadTemplate(routeParam(req.params.id), req.user!, "edit");
        if (input && input.revision !== template.revision) throw httpError("详情页模板已在其他页面更新，请刷新后重试", 409, "REVISION_CONFLICT");
        const deleted = await prisma.detailPageTemplate.deleteMany({ where: { id: template.id, ...(input ? { revision: input.revision } : {}) } });
        if (!deleted.count) throw httpError("详情页模板已在其他页面更新，请刷新后重试", 409, "REVISION_CONFLICT");
        res.json({ ok: true });
    } catch (error) { next(error); }
});

export { router as detailPageTemplateRouter };

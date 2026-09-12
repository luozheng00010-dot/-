import type { User } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { accessLevel, accessibleOwnerIds, assertAccess, requireReadyUser } from "./access.js";
import { prisma } from "./db.js";
import { mediaResponse } from "./media.js";

const router = Router();
const MAX_REFERENCES = 6;
const jsonMedia = (media: any) => media ? { ...mediaResponse(media), mediaId: media.id, storageKey: `media:${media.id}` } : undefined;
const routeParam = (value: string | string[]) => Array.isArray(value) ? value[0] : value;
const httpError = (message: string, status: number, code?: string) => Object.assign(new Error(message), { status, code });
const include = { references: { include: { media: true }, orderBy: { sortOrder: "asc" as const } } };

function templateResponse(template: any, user: User) {
    const references = (template.references || []).map((item: any) => ({ id: item.id, mediaId: item.mediaId, sortOrder: item.sortOrder, image: jsonMedia(item.media), createdAt: item.createdAt }));
    return accessLevel(user, template.ownerId).then((level) => ({ id: template.id, ownerId: template.ownerId, ownerUsername: template.owner?.username, name: template.name, revision: template.revision, referenceCount: references.length, coverImage: references[0]?.image, references, accessLevel: level, createdAt: template.createdAt, updatedAt: template.updatedAt }));
}

async function load(id: string, user: User, required: "view" | "edit") {
    const item = await prisma.mainImageReplicationTemplate.findUniqueOrThrow({ where: { id }, include: { ...include, owner: { select: { username: true } } } });
    await assertAccess(user, item.ownerId, required); return item;
}

async function validateMedia(ids: string[], user: User, ownerId: string) {
    if (ids.length < 1 || ids.length > MAX_REFERENCES) throw httpError(`主图模板参考图数量必须为 1-${MAX_REFERENCES} 张`, 400);
    if (new Set(ids).size !== ids.length) throw httpError("模板参考图不能重复", 400);
    const media = await prisma.mediaFile.findMany({ where: { id: { in: ids } } });
    if (media.length !== ids.length) throw httpError("部分模板参考图不存在", 404);
    for (const item of media) { await assertAccess(user, item.ownerId, "view"); if (item.ownerId !== ownerId) throw httpError("模板参考图必须属于同一成员", 403); if (!item.mimeType.startsWith("image/")) throw httpError("模板参考图必须是图片", 400); if (item.bytes > BigInt(20 * 1024 * 1024)) throw httpError("单张模板参考图不能超过 20MB", 400); }
}

router.use(requireReadyUser);
router.use((_req, _res, next) => { const client = prisma as unknown as { mainImageReplicationTemplate?: unknown; mainImageReplicationTemplateReference?: unknown }; if (!client.mainImageReplicationTemplate || !client.mainImageReplicationTemplateReference) return next(httpError("主图模板服务未完成初始化，请重启开发服务", 503)); next(); });

router.get("/", async (req, res, next) => { try { const owners = await accessibleOwnerIds(req.user!, String(req.query.owner || "self")); const keyword = String(req.query.keyword || "").trim().slice(0, 100); const page = Math.max(1, Number(req.query.page) || 1); const pageSize = Math.max(1, Math.min(50, Number(req.query.pageSize) || 24)); const where = { ownerId: { in: owners }, ...(keyword ? { name: { contains: keyword, mode: "insensitive" as const } } : {}) }; const [total, items] = await Promise.all([prisma.mainImageReplicationTemplate.count({ where }), prisma.mainImageReplicationTemplate.findMany({ where, include: { ...include, owner: { select: { username: true } } }, orderBy: { updatedAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize })]); res.json({ items: await Promise.all(items.map((item) => templateResponse(item, req.user!))), total, page, pageSize }); } catch (error) { next(error); } });
router.get("/:id", async (req, res, next) => { try { res.json({ item: await templateResponse(await load(routeParam(req.params.id), req.user!, "view"), req.user!) }); } catch (error) { next(error); } });
router.post("/", async (req, res, next) => { try { const input = z.object({ ownerId: z.string().uuid().optional(), name: z.string().trim().min(1).max(100), referenceMediaIds: z.array(z.string().uuid()).min(1).max(MAX_REFERENCES) }).parse(req.body); const ownerId = input.ownerId || req.user!.id; await assertAccess(req.user!, ownerId, "edit"); await validateMedia(input.referenceMediaIds, req.user!, ownerId); const item = await prisma.mainImageReplicationTemplate.create({ data: { ownerId, createdById: req.user!.id, updatedById: req.user!.id, name: input.name, references: { create: input.referenceMediaIds.map((mediaId, sortOrder) => ({ mediaId, sortOrder })) } }, include: { ...include, owner: { select: { username: true } } } }); res.status(201).json({ item: await templateResponse(item, req.user!) }); } catch (error) { next(error); } });
router.patch("/:id", async (req, res, next) => { try { const input = z.object({ revision: z.number().int().positive(), name: z.string().trim().min(1).max(100).optional(), referenceMediaIds: z.array(z.string().uuid()).min(1).max(MAX_REFERENCES).optional() }).parse(req.body); const current = await load(routeParam(req.params.id), req.user!, "edit"); if (input.referenceMediaIds) await validateMedia(input.referenceMediaIds, req.user!, current.ownerId); const updated = await prisma.$transaction(async (tx) => { const changed = await tx.mainImageReplicationTemplate.updateMany({ where: { id: current.id, revision: input.revision }, data: { ...(input.name ? { name: input.name } : {}), updatedById: req.user!.id, revision: { increment: 1 } } }); if (!changed.count) throw httpError("主图模板已在其他页面更新，请刷新后重试", 409, "REVISION_CONFLICT"); if (input.referenceMediaIds) { await tx.mainImageReplicationTemplateReference.deleteMany({ where: { templateId: current.id } }); await tx.mainImageReplicationTemplateReference.createMany({ data: input.referenceMediaIds.map((mediaId, sortOrder) => ({ templateId: current.id, mediaId, sortOrder })) }); } return tx.mainImageReplicationTemplate.findUniqueOrThrow({ where: { id: current.id }, include: { ...include, owner: { select: { username: true } } } }); }); res.json({ item: await templateResponse(updated, req.user!) }); } catch (error) { next(error); } });
router.delete("/:id", async (req, res, next) => { try { const current = await load(routeParam(req.params.id), req.user!, "edit"); const revision = Number((req.body || {}).revision); if (!Number.isInteger(revision) || revision !== current.revision) throw httpError("主图模板已在其他页面更新，请刷新后重试", 409, "REVISION_CONFLICT"); await prisma.mainImageReplicationTemplate.delete({ where: { id: current.id } }); res.status(204).end(); } catch (error) { next(error); } });

export default router;

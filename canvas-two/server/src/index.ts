import { Readable } from "node:stream";
import type { Prisma, User } from "@prisma/client";
import cookieParser from "cookie-parser";
import express, { type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import multer from "multer";
import { z } from "zod";
import { accessLevel, accessibleOwnerIds, assertAccess, loadSession, publicUser, requireAdmin, requireAuth, requireReadyUser } from "./access.js";
import { env, isProduction } from "./config.js";
import { prisma } from "./db.js";
import { assertPassword, assertUsername, clearSessionCookie, decryptSecret, encryptSecret, hashPassword, hashToken, newSessionToken, normalizeUsername, sessionExpiry, setSessionCookie, verifyPassword } from "./security.js";
import { ensureBucket, getObject, getPartialObject } from "./storage.js";
import { mergeUpstreamUrl, safeUpstreamError } from "./ai-utils.js";
import { mediaResponse, storeGeneratedImages, storeMediaBuffer, storeMediaThumbnail } from "./media.js";
import { imageTaskRouter } from "./image-tasks.js";
import { productRouter } from "./products.js";
import { detailPageRouter } from "./detail-pages.js";
import { detailPageTemplateRouter } from "./detail-page-templates.js";
import mainImageReplicationRouter from "./main-image-replications.js";
import mainImageReplicationTemplateRouter from "./main-image-replication-templates.js";
import { kbRouter } from "./kb/routes.js";
import videoMaterialsRouter from "./video/routes-materials.js";
import videoScriptsRouter from "./video/routes-scripts.js";
import videoExportsRouter from "./video/routes-exports.js";
import videoSettingsRouter from "./video/routes-settings.js";
import videoSkusRouter from "./video/routes-skus.js";
import videoTtsRouter from "./video/routes-tts.js";
import videoCategoriesRouter from "./video/routes-categories.js";

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 250 * 1024 * 1024 } });
app.set("trust proxy", 1);
app.use(cookieParser());
app.use(express.json({ limit: "60mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));
app.use(loadSession);

function firstHeaderValue(value: string | string[] | undefined) {
    const raw = Array.isArray(value) ? value[0] : value;
    return raw?.split(",")[0]?.trim() || "";
}

function requestExternalHost(req: Request) {
    return firstHeaderValue(req.headers["x-forwarded-host"]) || firstHeaderValue(req.headers.host);
}

app.use((req, _res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method) || !req.headers.origin) return next();
    try {
        const originHost = new URL(req.headers.origin).host.toLowerCase();
        const externalHost = requestExternalHost(req).toLowerCase();
        if (!externalHost || originHost !== externalHost) return next(Object.assign(new Error("Request origin validation failed"), { status: 403 }));
    } catch {
        return next(Object.assign(new Error("Request origin validation failed"), { status: 403 }));
    }
    next();
});

const asyncRoute = (handler: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => void handler(req, res).catch(next);
const jsonPayload = (value: unknown) => value as Prisma.InputJsonValue;
const ownerSelect = { id: true, username: true } as const;
const actorSelect = { id: true, username: true } as const;
const routeParam = (value: string | string[]) => Array.isArray(value) ? value[0] : value;
function ownedResource(item: any) {
    const { owner, createdBy, updatedBy, payload, ...record } = item;
    const data: Record<string, unknown> = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : { payload };
    return { ...record, ...data, serverId: record.id, id: data["id"] || record.id, revision: record.revision, ownerId: owner.id, ownerUsername: owner.username, createdByUsername: createdBy.username, updatedByUsername: updatedBy?.username || createdBy.username };
}

async function seedRoot() {
    const existing = await prisma.user.findFirst();
    if (existing) return;
    await prisma.user.create({ data: { username: "root", usernameKey: "root", passwordHash: await hashPassword("root"), role: "admin", mustChangePassword: true } });
    console.warn("[security] Created initial administrator root/root; password change is required on first login");
}

app.get("/api/health", asyncRoute(async (_req, res) => {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true });
}));

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });
app.post("/api/auth/login", loginLimiter, asyncRoute(async (req, res) => {
    const input = z.object({ username: z.string(), password: z.string() }).parse(req.body);
    const user = await prisma.user.findUnique({ where: { usernameKey: normalizeUsername(input.username) } });
    if (!user || user.deletedAt || !(await verifyPassword(user.passwordHash, input.password))) throw Object.assign(new Error("Invalid username or password"), { status: 401 });
    const token = newSessionToken();
    const expiresAt = sessionExpiry();
    await prisma.session.create({ data: { tokenHash: hashToken(token), userId: user.id, expiresAt } });
    setSessionCookie(res, token, expiresAt);
    res.json({ user: publicUser(user) });
}));
// 自助注册已关闭：账号统一由管理员在管理员控制台创建（POST /api/admin/users）
app.post("/api/auth/register", (_req, res) => {
    res.status(403).json({ error: "注册已关闭，账号由管理员统一创建" });
});
app.post("/api/auth/logout", requireAuth, asyncRoute(async (req, res) => {
    if (req.sessionId) await prisma.session.delete({ where: { id: req.sessionId } }).catch(() => undefined);
    clearSessionCookie(res);
    res.json({ ok: true });
}));
app.get("/api/auth/me", requireAuth, asyncRoute(async (req, res) => res.json({ user: publicUser(req.user!) })));
app.post("/api/auth/change-password", requireAuth, asyncRoute(async (req, res) => {
    const input = z.object({ currentPassword: z.string(), newPassword: z.string() }).parse(req.body);
    assertPassword(input.newPassword);
    if (!(await verifyPassword(req.user!.passwordHash, input.currentPassword))) throw Object.assign(new Error("Current password is incorrect"), { status: 400 });
    const passwordHash = await hashPassword(input.newPassword);
    const user = await prisma.$transaction(async (tx) => {
        const updated = await tx.user.update({ where: { id: req.user!.id }, data: { passwordHash, mustChangePassword: false } });
        await tx.session.deleteMany({ where: { userId: req.user!.id, id: { not: req.sessionId } } });
        return updated;
    });
    res.json({ user: publicUser(user) });
}));

app.get("/api/members/accessible", requireReadyUser, asyncRoute(async (req, res) => {
    if (req.user!.role === "admin") {
        const users = await prisma.user.findMany({ where: { deletedAt: null }, orderBy: { usernameKey: "asc" } });
        return res.json({ members: users.map((user) => ({ ...publicUser(user), accessLevel: "edit", isSelf: user.id === req.user!.id })) });
    }
    const grants = await prisma.memberPermission.findMany({ where: { granteeId: req.user!.id, target: { deletedAt: null } }, include: { target: true }, orderBy: { target: { usernameKey: "asc" } } });
    res.json({ members: [{ ...publicUser(req.user!), accessLevel: "edit", isSelf: true }, ...grants.map((grant) => ({ ...publicUser(grant.target), accessLevel: grant.level, isSelf: false }))] });
}));

app.get("/api/admin/users", requireAdmin, asyncRoute(async (_req, res) => {
    const users = await prisma.user.findMany({ orderBy: [{ deletedAt: "asc" }, { usernameKey: "asc" }], include: { grantedPermissions: true } });
    res.json({ users: users.map((user) => ({ ...publicUser(user), deletedAt: user.deletedAt, createdAt: user.createdAt, permissions: user.grantedPermissions.map((item) => ({ targetUserId: item.targetId, level: item.level })) })) });
}));
app.post("/api/admin/users", requireAdmin, asyncRoute(async (req, res) => {
    const input = z.object({ username: z.string(), password: z.string() }).parse(req.body);
    const username = assertUsername(input.username);
    assertPassword(input.password);
    if (normalizeUsername(username) === "root") throw Object.assign(new Error("root is a reserved account"), { status: 409 });
    const user = await prisma.user.create({ data: { username, usernameKey: normalizeUsername(username), passwordHash: await hashPassword(input.password), role: "member" } }).catch((error) => {
        if ((error as { code?: string }).code === "P2002") throw Object.assign(new Error("Username already exists"), { status: 409 });
        throw error;
    });
    res.status(201).json({ user: publicUser(user) });
}));
app.post("/api/admin/users/:id/reset-password", requireAdmin, asyncRoute(async (req, res) => {
    const input = z.object({ password: z.string() }).parse(req.body);
    assertPassword(input.password);
    const target = await prisma.user.findUniqueOrThrow({ where: { id: routeParam(req.params.id) } });
    if (target.role === "admin") throw Object.assign(new Error("Administrator password can only be changed by the administrator"), { status: 400 });
    await prisma.$transaction([prisma.user.update({ where: { id: target.id }, data: { passwordHash: await hashPassword(input.password), mustChangePassword: true } }), prisma.session.deleteMany({ where: { userId: target.id } })]);
    res.json({ ok: true });
}));
app.delete("/api/admin/users/:id", requireAdmin, asyncRoute(async (req, res) => {
    const target = await prisma.user.findUniqueOrThrow({ where: { id: routeParam(req.params.id) } });
    if (target.role === "admin") throw Object.assign(new Error("Administrator account cannot be deleted"), { status: 400 });
    await prisma.$transaction([prisma.user.update({ where: { id: target.id }, data: { deletedAt: new Date() } }), prisma.session.deleteMany({ where: { userId: target.id } })]);
    res.json({ ok: true });
}));
app.post("/api/admin/users/:id/restore", requireAdmin, asyncRoute(async (req, res) => {
    const target = await prisma.user.findUniqueOrThrow({ where: { id: routeParam(req.params.id) } });
    const user = await prisma.user.update({ where: { id: target.id }, data: { deletedAt: null } });
    res.json({ user: publicUser(user) });
}));
app.put("/api/admin/users/:id/permissions", requireAdmin, asyncRoute(async (req, res) => {
    const input = z.object({ grants: z.array(z.object({ targetUserId: z.string().uuid(), level: z.enum(["view", "edit"]) })) }).parse(req.body);
    const grantee = await prisma.user.findUniqueOrThrow({ where: { id: routeParam(req.params.id) } });
    if (grantee.role === "admin") throw Object.assign(new Error("Administrator does not require explicit grants"), { status: 400 });
    const grants = input.grants.filter((item) => item.targetUserId !== grantee.id);
    await prisma.$transaction(async (tx) => {
        await tx.memberPermission.deleteMany({ where: { granteeId: grantee.id } });
        if (grants.length) await tx.memberPermission.createMany({ data: grants.map((item) => ({ granteeId: grantee.id, targetId: item.targetUserId, level: item.level })) });
    });
    res.json({ ok: true });
}));

app.get("/api/models", requireReadyUser, asyncRoute(async (_req, res) => {
    const channels = await prisma.modelChannel.findMany({ where: { enabled: true }, include: { models: { where: { enabled: true }, orderBy: { name: "asc" } } }, orderBy: { name: "asc" } });
    res.json({ channels: channels.map((channel) => ({ id: channel.id, name: channel.name, apiFormat: channel.apiFormat, models: channel.models.map((model) => ({ id: model.id, name: model.name, capability: model.capability })) })) });
}));
app.get("/api/admin/channels", requireAdmin, asyncRoute(async (_req, res) => {
    const channels = await prisma.modelChannel.findMany({ include: { models: true }, orderBy: { name: "asc" } });
    res.json({ channels: channels.map((channel) => ({ id: channel.id, name: channel.name, baseUrl: channel.baseUrl, apiFormat: channel.apiFormat, apiKeyMasked: channel.apiKeyEncrypted ? "********" : "", enabled: channel.enabled, models: channel.models })) });
}));
const channelInput = z.object({ name: z.string().min(1).max(50), baseUrl: z.string().url(), apiFormat: z.enum(["openai", "gemini", "ark"]), apiKey: z.string().optional(), enabled: z.boolean().default(true), models: z.array(z.object({ name: z.string().min(1), capability: z.enum(["image", "video", "text", "audio"]), enabled: z.boolean().default(true) })) });
const channelModelsInput = z.object({ channelId: z.string().optional(), baseUrl: z.string().url(), apiFormat: z.enum(["openai", "gemini", "ark"]), apiKey: z.string().optional() });
app.post("/api/admin/channels/fetch-models", requireAdmin, asyncRoute(async (req, res) => {
    const input = channelModelsInput.parse(req.body);
    const stored = input.channelId ? await prisma.modelChannel.findUnique({ where: { id: input.channelId } }) : null;
    const apiKey = input.apiKey?.trim() || (stored ? decryptSecret(stored.apiKeyEncrypted) : "");
    if (!apiKey) throw Object.assign(new Error("请先填写 API Key"), { status: 400 });
    const basePath = new URL(input.baseUrl).pathname.replace(/\/+$/, "").toLowerCase();
    const suffix = input.apiFormat === "gemini" ? "/v1beta/models" : basePath.endsWith("/api/plan/v3") ? "/api/plan/v3/models" : basePath.endsWith("/api/v3") ? "/api/v3/models" : "/v1/models";
    const upstreamUrl = mergeUpstreamUrl(input.baseUrl, suffix);
    if (input.apiFormat === "gemini") upstreamUrl.searchParams.set("key", apiKey);
    let upstream: globalThis.Response;
    try {
        upstream = await fetch(upstreamUrl, { headers: input.apiFormat === "gemini" ? { "x-goog-api-key": apiKey } : { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(20_000) });
    } catch (error) {
        const timeout = error instanceof DOMException && error.name === "TimeoutError";
        throw Object.assign(new Error(timeout ? "获取模型超时，请检查请求地址和服务状态" : "无法连接模型服务，请检查请求地址、网络或服务状态"), { status: 502 });
    }
    const text = await upstream.text();
    let payload: any = {};
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = {}; }
    if (!upstream.ok) {
        const detail = payload?.error?.message || payload?.message || payload?.msg || payload?.detail || text || upstream.statusText;
        const safeDetail = String(detail).replaceAll(apiKey, "********").slice(0, 500);
        throw Object.assign(new Error(`获取模型失败（HTTP ${upstream.status}）：${safeDetail || "上游服务未返回错误原因"}`), { status: upstream.status >= 400 && upstream.status < 500 ? upstream.status : 502 });
    }
    const items = input.apiFormat === "gemini" ? payload?.models : payload?.data || payload?.models;
    const models = Array.isArray(items) ? items.map((item: any) => String(item?.id || item?.name || "").replace(/^models\//, "")).filter(Boolean).sort((a: string, b: string) => a.localeCompare(b)) : [];
    if (!models.length) throw Object.assign(new Error("模型服务未返回可用模型，请检查接口是否支持模型列表"), { status: 502 });
    res.json({ models: Array.from(new Set(models)) });
}));
app.post("/api/admin/channels", requireAdmin, asyncRoute(async (req, res) => {
    const input = channelInput.parse(req.body);
    if (!input.apiKey) throw Object.assign(new Error("API Key is required"), { status: 400 });
    const channel = await prisma.modelChannel.create({ data: { name: input.name, baseUrl: input.baseUrl.replace(/\/+$/, ""), apiFormat: input.apiFormat, apiKeyEncrypted: encryptSecret(input.apiKey), enabled: input.enabled, models: { create: input.models } }, include: { models: true } });
    res.status(201).json({ channel: { ...channel, apiKeyEncrypted: undefined, apiKeyMasked: "********" } });
}));
app.put("/api/admin/channels/:id", requireAdmin, asyncRoute(async (req, res) => {
    const input = channelInput.parse(req.body);
    const current = await prisma.modelChannel.findUniqueOrThrow({ where: { id: routeParam(req.params.id) } });
    const channel = await prisma.$transaction(async (tx) => {
        await tx.channelModel.deleteMany({ where: { channelId: current.id } });
        return tx.modelChannel.update({ where: { id: current.id }, data: { name: input.name, baseUrl: input.baseUrl.replace(/\/+$/, ""), apiFormat: input.apiFormat, enabled: input.enabled, ...(input.apiKey ? { apiKeyEncrypted: encryptSecret(input.apiKey) } : {}), models: { create: input.models } }, include: { models: true } });
    });
    res.json({ channel: { ...channel, apiKeyEncrypted: undefined, apiKeyMasked: "********" } });
}));
app.delete("/api/admin/channels/:id", requireAdmin, asyncRoute(async (req, res) => {
    await prisma.modelChannel.delete({ where: { id: routeParam(req.params.id) } });
    res.json({ ok: true });
}));

async function targetOwner(user: User, requested?: string) {
    const ownerId = requested || user.id;
    await assertAccess(user, ownerId, "edit");
    return ownerId;
}

const CANVAS_LEASE_MS = 45_000;
const canvasClientIdInput = z.string().min(8).max(200);

function canvasLeaseResponse(lease: any) {
    if (!lease) return undefined;
    return {
        holderId: lease.holderId,
        holderUsername: lease.holder?.username || "",
        clientId: lease.clientId,
        acquiredAt: lease.acquiredAt,
        heartbeatAt: lease.heartbeatAt,
        expiresAt: lease.expiresAt,
    };
}

async function findCanvasLease(canvasId: string) {
    return prisma.canvasEditLease.findUnique({ where: { canvasId }, include: { holder: { select: { id: true, username: true } } } });
}

async function renewCanvasLease(user: User, canvasId: string, clientId: string) {
    const now = new Date();
    const renewed = await prisma.canvasEditLease.updateMany({
        where: { canvasId, holderId: user.id, clientId, expiresAt: { gt: now } },
        data: { heartbeatAt: now, expiresAt: new Date(now.getTime() + CANVAS_LEASE_MS) },
    });
    if (!renewed.count) {
        const lease = await findCanvasLease(canvasId);
        const activeLease = lease && lease.expiresAt > now ? lease : undefined;
        throw Object.assign(new Error(activeLease ? `当前画布由 ${activeLease.holder.username} 编辑，请先接管编辑` : "画布编辑租约已失效，请先接管编辑"), {
            status: 423,
            code: activeLease ? "CANVAS_EDIT_LOCKED" : "CANVAS_EDIT_LEASE_LOST",
        });
    }
    return findCanvasLease(canvasId);
}

app.get("/api/canvases", requireReadyUser, asyncRoute(async (req, res) => {
    const ownerIds = await accessibleOwnerIds(req.user!, String(req.query.owner || "self"));
    const items = await prisma.canvasProject.findMany({ where: { ownerId: { in: ownerIds } }, include: { owner: { select: ownerSelect }, createdBy: { select: actorSelect }, updatedBy: { select: actorSelect } }, orderBy: { updatedAt: "desc" } });
    res.json({ items: items.map(ownedResource) });
}));
app.post("/api/canvases", requireReadyUser, asyncRoute(async (req, res) => {
    const input = z.object({ ownerId: z.string().uuid().optional(), title: z.string().min(1).max(200), payload: z.record(z.unknown()), legacyId: z.string().optional() }).parse(req.body);
    const ownerId = await targetOwner(req.user!, input.ownerId);
    let item = input.legacyId ? await prisma.canvasProject.findFirst({ where: { ownerId, legacyId: input.legacyId }, include: { owner: { select: ownerSelect }, createdBy: { select: actorSelect }, updatedBy: { select: actorSelect } } }) : null;
    item ||= await prisma.canvasProject.create({ data: { ownerId, createdById: req.user!.id, updatedById: req.user!.id, title: input.title, payload: jsonPayload(input.payload), legacyId: input.legacyId }, include: { owner: { select: ownerSelect }, createdBy: { select: actorSelect }, updatedBy: { select: actorSelect } } });
    res.status(201).json({ item: ownedResource(item) });
}));
app.get("/api/canvases/:id/revision", requireReadyUser, asyncRoute(async (req, res) => {
    const canvasId = routeParam(req.params.id);
    const item = await prisma.canvasProject.findUniqueOrThrow({ where: { id: canvasId } });
    const level = await assertAccess(req.user!, item.ownerId, "view");
    const lease = await findCanvasLease(canvasId);
    res.json({ revision: item.revision, updatedAt: item.updatedAt, accessLevel: level, lease: lease && lease.expiresAt > new Date() ? canvasLeaseResponse(lease) : undefined });
}));
app.get("/api/canvases/:id", requireReadyUser, asyncRoute(async (req, res) => {
    const item = await prisma.canvasProject.findUniqueOrThrow({ where: { id: routeParam(req.params.id) }, include: { owner: { select: ownerSelect }, createdBy: { select: actorSelect }, updatedBy: { select: actorSelect } } });
    const level = await assertAccess(req.user!, item.ownerId, "view");
    res.json({ item: ownedResource(item), accessLevel: level });
}));

app.post("/api/canvases/:id/edit-lease", requireReadyUser, asyncRoute(async (req, res) => {
    const input = z.object({ clientId: canvasClientIdInput, takeover: z.boolean().optional() }).parse(req.body);
    const canvasId = routeParam(req.params.id);
    const item = await prisma.canvasProject.findUniqueOrThrow({ where: { id: canvasId } });
    await assertAccess(req.user!, item.ownerId, "edit");
    const now = new Date();
    const expiresAt = new Date(now.getTime() + CANVAS_LEASE_MS);
    const renewed = await prisma.canvasEditLease.updateMany({
        where: { canvasId, holderId: req.user!.id, clientId: input.clientId, expiresAt: { gt: now } },
        data: { heartbeatAt: now, expiresAt },
    });
    if (renewed.count) return res.json({ acquired: true, lease: canvasLeaseResponse(await findCanvasLease(canvasId)) });

    const claimed = await prisma.canvasEditLease.updateMany({
        where: { canvasId, expiresAt: { lte: now } },
        data: { holderId: req.user!.id, clientId: input.clientId, acquiredAt: now, heartbeatAt: now, expiresAt },
    });
    if (claimed.count) return res.json({ acquired: true, lease: canvasLeaseResponse(await findCanvasLease(canvasId)) });

    try {
        const lease = await prisma.canvasEditLease.create({ data: { canvasId, holderId: req.user!.id, clientId: input.clientId, acquiredAt: now, heartbeatAt: now, expiresAt }, include: { holder: { select: { id: true, username: true } } } });
        return res.json({ acquired: true, lease: canvasLeaseResponse(lease) });
    } catch (error) {
        if ((error as { code?: string }).code !== "P2002") throw error;
    }
    res.json({ acquired: false, lease: canvasLeaseResponse(await findCanvasLease(canvasId)) });
}));

app.post("/api/canvases/:id/edit-lease/heartbeat", requireReadyUser, asyncRoute(async (req, res) => {
    const input = z.object({ clientId: canvasClientIdInput }).parse(req.body);
    const canvasId = routeParam(req.params.id);
    const item = await prisma.canvasProject.findUniqueOrThrow({ where: { id: canvasId } });
    await assertAccess(req.user!, item.ownerId, "edit");
    const lease = await renewCanvasLease(req.user!, canvasId, input.clientId);
    res.json({ acquired: true, lease: canvasLeaseResponse(lease) });
}));

app.post("/api/canvases/:id/edit-lease/release", requireReadyUser, asyncRoute(async (req, res) => {
    const input = z.object({ clientId: canvasClientIdInput }).parse(req.body);
    const canvasId = routeParam(req.params.id);
    const item = await prisma.canvasProject.findUniqueOrThrow({ where: { id: canvasId } });
    await assertAccess(req.user!, item.ownerId, "edit");
    const result = await prisma.canvasEditLease.deleteMany({ where: { canvasId, holderId: req.user!.id, clientId: input.clientId } });
    res.json({ released: result.count > 0 });
}));

app.patch("/api/canvases/:id", requireReadyUser, asyncRoute(async (req, res) => {
    const input = z.object({ revision: z.number().int().positive(), clientId: canvasClientIdInput, title: z.string().min(1).max(200).optional(), payload: z.record(z.unknown()).optional() }).parse(req.body);
    const current = await prisma.canvasProject.findUniqueOrThrow({ where: { id: routeParam(req.params.id) } });
    await assertAccess(req.user!, current.ownerId, "edit");
    await renewCanvasLease(req.user!, current.id, input.clientId);
    const result = await prisma.canvasProject.updateMany({ where: { id: current.id, revision: input.revision }, data: { ...(input.title ? { title: input.title } : {}), ...(input.payload ? { payload: jsonPayload(input.payload) } : {}), updatedById: req.user!.id, revision: { increment: 1 } } });
    if (!result.count) throw Object.assign(new Error("Canvas was updated in another browser; reload required"), { status: 409, code: "REVISION_CONFLICT" });
    const item = await prisma.canvasProject.findUniqueOrThrow({ where: { id: current.id }, include: { owner: { select: ownerSelect }, createdBy: { select: actorSelect }, updatedBy: { select: actorSelect } } });
    res.json({ item: ownedResource(item) });
}));
app.delete("/api/canvases/:id", requireReadyUser, asyncRoute(async (req, res) => {
    const input = z.object({ clientId: canvasClientIdInput }).parse(req.body || {});
    const current = await prisma.canvasProject.findUniqueOrThrow({ where: { id: routeParam(req.params.id) } });
    await assertAccess(req.user!, current.ownerId, "edit");
    await renewCanvasLease(req.user!, current.id, input.clientId);
    await prisma.canvasProject.delete({ where: { id: current.id } });
    res.json({ ok: true });
}));

for (const resource of ["generations", "assets"] as const) {
    app.get(`/api/${resource}`, requireReadyUser, asyncRoute(async (req, res) => {
        const ownerIds = await accessibleOwnerIds(req.user!, String(req.query.owner || "self"));
        if (resource === "generations") {
            const kind = req.query.kind ? String(req.query.kind) : undefined;
            const items = await prisma.workbenchGeneration.findMany({ where: { ownerId: { in: ownerIds }, ...(kind ? { kind } : {}) }, include: { owner: { select: ownerSelect }, createdBy: { select: actorSelect }, updatedBy: { select: actorSelect } }, orderBy: { createdAt: "desc" } });
            return res.json({ items: items.map(ownedResource) });
        }
        const items = await prisma.asset.findMany({ where: { ownerId: { in: ownerIds } }, include: { owner: { select: ownerSelect }, createdBy: { select: actorSelect }, updatedBy: { select: actorSelect } }, orderBy: { updatedAt: "desc" } });
        res.json({ items: items.map(ownedResource) });
    }));
    app.post(`/api/${resource}`, requireReadyUser, asyncRoute(async (req, res) => {
        const input = z.object({ ownerId: z.string().uuid().optional(), kind: z.string().min(1), title: z.string().default(""), status: z.string().optional(), payload: z.record(z.unknown()), legacyId: z.string().optional() }).parse(req.body);
        const ownerId = await targetOwner(req.user!, input.ownerId);
        if (resource === "generations") {
            let item = input.legacyId ? await prisma.workbenchGeneration.findFirst({ where: { ownerId, kind: input.kind, legacyId: input.legacyId }, include: { owner: { select: ownerSelect }, createdBy: { select: actorSelect }, updatedBy: { select: actorSelect } } }) : null;
            item ||= await prisma.workbenchGeneration.create({ data: { ownerId, createdById: req.user!.id, updatedById: req.user!.id, kind: input.kind, title: input.title, status: input.status || "success", payload: jsonPayload(input.payload), legacyId: input.legacyId }, include: { owner: { select: ownerSelect }, createdBy: { select: actorSelect }, updatedBy: { select: actorSelect } } });
            return res.status(201).json({ item: ownedResource(item) });
        }
        let item = input.legacyId ? await prisma.asset.findFirst({ where: { ownerId, legacyId: input.legacyId }, include: { owner: { select: ownerSelect }, createdBy: { select: actorSelect }, updatedBy: { select: actorSelect } } }) : null;
        item ||= await prisma.asset.create({ data: { ownerId, createdById: req.user!.id, updatedById: req.user!.id, kind: input.kind, title: input.title, payload: jsonPayload(input.payload), legacyId: input.legacyId }, include: { owner: { select: ownerSelect }, createdBy: { select: actorSelect }, updatedBy: { select: actorSelect } } });
        res.status(201).json({ item: ownedResource(item) });
    }));
    app.patch(`/api/${resource}/:id`, requireReadyUser, asyncRoute(async (req, res) => {
        const input = z.object({ revision: z.number().int().positive(), title: z.string().optional(), status: z.string().optional(), payload: z.record(z.unknown()).optional() }).parse(req.body);
        const model = resource === "generations" ? prisma.workbenchGeneration : prisma.asset;
        const current = await (model as typeof prisma.asset).findUniqueOrThrow({ where: { id: routeParam(req.params.id) } });
        await assertAccess(req.user!, current.ownerId, "edit");
        const result = await (model as typeof prisma.asset).updateMany({ where: { id: current.id, revision: input.revision }, data: { ...(input.title !== undefined ? { title: input.title } : {}), ...(input.payload ? { payload: jsonPayload(input.payload) } : {}), ...(resource === "generations" && input.status ? { status: input.status } : {}), updatedById: req.user!.id, revision: { increment: 1 } } as never });
        if (!result.count) throw Object.assign(new Error("Data was updated in another browser; reload required"), { status: 409, code: "REVISION_CONFLICT" });
        const item = await (model as typeof prisma.asset).findUniqueOrThrow({ where: { id: current.id }, include: { owner: { select: ownerSelect }, createdBy: { select: actorSelect }, updatedBy: { select: actorSelect } } });
        res.json({ item: ownedResource(item as never) });
    }));
    app.delete(`/api/${resource}/:id`, requireReadyUser, asyncRoute(async (req, res) => {
        const model = resource === "generations" ? prisma.workbenchGeneration : prisma.asset;
        const current = await (model as typeof prisma.asset).findUniqueOrThrow({ where: { id: routeParam(req.params.id) } });
        await assertAccess(req.user!, current.ownerId, "edit");
        await (model as typeof prisma.asset).delete({ where: { id: current.id } });
        res.json({ ok: true });
    }));
}

app.use("/api/image-generation-tasks", imageTaskRouter);
app.use("/api/products", productRouter);
app.use("/api/detail-page-projects", detailPageRouter);
app.use("/api/detail-page-templates", detailPageTemplateRouter);
app.use("/api/main-image-replication-projects", mainImageReplicationRouter);
app.use("/api/main-image-replication-templates", mainImageReplicationTemplateRouter);
app.use("/api/kb", kbRouter);
app.use("/api/video", videoMaterialsRouter);
app.use("/api/video", videoScriptsRouter);
app.use("/api/video", videoExportsRouter);
app.use("/api/video", videoSettingsRouter);
app.use("/api/video", videoSkusRouter);
app.use("/api/video", videoTtsRouter);
app.use("/api/video", videoCategoriesRouter);

app.post("/api/media", requireReadyUser, upload.fields([{ name: "file", maxCount: 1 }, { name: "thumbnail", maxCount: 1 }]), asyncRoute(async (req, res) => {
    const files = req.files as { file?: Express.Multer.File[]; thumbnail?: Express.Multer.File[] } | undefined;
    const file = files?.file?.[0];
    if (!file) throw Object.assign(new Error("File is required"), { status: 400 });
    const ownerId = await targetOwner(req.user!, String(req.body.ownerId || req.user!.id));
    const visibility = String(req.body.visibility || "") === "public" ? "public" as const : "private" as const;
    const origin = String(req.body.origin || "") === "kb" ? "kb" : "upload";
    const legacyStorageKey = String(req.body.legacyStorageKey || "") || undefined;
    if (legacyStorageKey) {
        const existing = await prisma.mediaFile.findFirst({ where: { ownerId, legacyStorageKey } });
        if (existing) return res.json({ item: mediaResponse(existing) });
    }
    const item = await storeMediaBuffer({ ownerId, createdById: req.user!.id, buffer: file.buffer, fileName: file.originalname || "file", mimeType: file.mimetype || "application/octet-stream", thumbnailBuffer: files?.thumbnail?.[0]?.buffer, legacyStorageKey, visibility, origin });
    res.status(201).json({ item: mediaResponse(item) });
}));
app.get("/api/media/:id/content", requireReadyUser, asyncRoute(async (req, res) => {
    const item = await prisma.mediaFile.findUniqueOrThrow({ where: { id: routeParam(req.params.id) } });
    if (item.visibility !== "public") await assertAccess(req.user!, item.ownerId, "view");
    res.setHeader("Content-Type", item.mimeType);
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.setHeader("Accept-Ranges", "bytes");
    const size = Number(item.bytes);
    const range = typeof req.headers.range === "string" ? req.headers.range : "";
    if (!range) {
        res.setHeader("Content-Length", String(size));
        (await getObject(item.objectKey)).pipe(res);
        return;
    }
    const matched = range.match(/^bytes=(\d*)-(\d*)$/);
    if (!matched || (!matched[1] && !matched[2])) {
        res.setHeader("Content-Range", `bytes */${size}`);
        throw Object.assign(new Error("请求的媒体范围无效"), { status: 416 });
    }
    const start = matched[1] ? Number(matched[1]) : Math.max(0, size - Number(matched[2]));
    const end = matched[2] ? Math.min(size - 1, Number(matched[2])) : size - 1;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= size || start > end) {
        res.setHeader("Content-Range", `bytes */${size}`);
        throw Object.assign(new Error("请求的媒体范围无效"), { status: 416 });
    }
    const length = end - start + 1;
    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
    res.setHeader("Content-Length", String(length));
    (await getPartialObject(item.objectKey, start, length)).pipe(res);
}));
app.get("/api/media/:id/thumbnail", requireReadyUser, asyncRoute(async (req, res) => {
    const item = await prisma.mediaFile.findUniqueOrThrow({ where: { id: routeParam(req.params.id) } });
    if (item.visibility !== "public") await assertAccess(req.user!, item.ownerId, "view");
    if (!item.thumbnailObjectKey && item.mimeType.startsWith("video/")) throw Object.assign(new Error("视频首帧缩略图不存在"), { status: 404 });
    res.setHeader("Content-Type", item.thumbnailMimeType || item.mimeType);
    res.setHeader("Content-Length", (item.thumbnailBytes || item.bytes).toString());
    res.setHeader("Cache-Control", "private, max-age=3600");
    (await getObject(item.thumbnailObjectKey || item.objectKey)).pipe(res);
}));
app.post("/api/media/:id/thumbnail", requireReadyUser, upload.single("thumbnail"), asyncRoute(async (req, res) => {
    if (!req.file) throw Object.assign(new Error("Thumbnail is required"), { status: 400 });
    const item = await prisma.mediaFile.findUniqueOrThrow({ where: { id: routeParam(req.params.id) } });
    await assertAccess(req.user!, item.ownerId, "edit");
    const updated = await storeMediaThumbnail(item, req.file.buffer);
    res.json({ item: mediaResponse(updated) });
}));

app.use("/api/ai/channels/:channelId", requireReadyUser, asyncRoute(async (req, res) => {
    const channel = await prisma.modelChannel.findUnique({ where: { id: routeParam(req.params.channelId) }, include: { models: { where: { enabled: true } } } });
    if (!channel || !channel.enabled) throw Object.assign(new Error("Model channel is unavailable"), { status: 404 });
    const suffix = req.originalUrl.split(`/api/ai/channels/${channel.id}`)[1] || "/";
    const bodyModel = req.body && typeof req.body === "object" && typeof req.body.model === "string" ? req.body.model : "";
    const pathModel = decodeURIComponent(suffix.match(/\/models\/([^/:?]+)/)?.[1] || "");
    const requestedModel = bodyModel || pathModel;
    if (requestedModel && !channel.models.some((model) => model.name === requestedModel)) throw Object.assign(new Error("Model is not enabled for this channel"), { status: 403 });
    const storeImages = req.headers["x-canvas-store-images"] === "1";
    const ownerId = storeImages ? await targetOwner(req.user!, String(req.headers["x-canvas-owner-id"] || req.user!.id)) : req.user!.id;
    const upstreamUrl = mergeUpstreamUrl(channel.baseUrl, suffix);
    const apiKey = decryptSecret(channel.apiKeyEncrypted);
    if (channel.apiFormat === "gemini") upstreamUrl.searchParams.set("key", apiKey);
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
        if (!value || ["host", "cookie", "content-length", "connection", "x-canvas-store-images", "x-canvas-owner-id"].includes(name.toLowerCase())) continue;
        headers.set(name, Array.isArray(value) ? value.join(",") : value);
    }
    if (channel.apiFormat === "gemini") headers.set("x-goog-api-key", apiKey);
    else headers.set("authorization", `Bearer ${apiKey}`);
    const hasBody = !["GET", "HEAD"].includes(req.method);
    let body: BodyInit | undefined;
    let duplex: "half" | undefined;
    if (hasBody && req.is("application/json")) body = JSON.stringify(req.body);
    else if (hasBody) {
        body = Readable.toWeb(req) as BodyInit;
        duplex = "half";
    }
    let upstream: globalThis.Response;
    try {
        upstream = await fetch(upstreamUrl, { method: req.method, headers, body, ...(duplex ? { duplex } : {}) } as RequestInit & { duplex?: "half" });
    } catch {
        throw Object.assign(new Error("无法连接模型服务，请检查管理员渠道请求地址、网络或服务状态"), { status: 502 });
    }
    if (storeImages) {
        const text = await upstream.text();
        let payload: any;
        try { payload = text ? JSON.parse(text) : {}; } catch { payload = null; }
        if (!upstream.ok) {
            return res.status(upstream.status).json({ error: { message: safeUpstreamError(payload, text || upstream.statusText, upstream.status, apiKey, "生图服务请求失败") } });
        }
        if (!payload) return res.status(502).json({ error: { message: "生图服务返回了无法解析的数据，请检查渠道接口兼容性" } });
        const items = await storeGeneratedImages(payload, ownerId, req.user!.id);
        return res.json({ data: items });
    }
    res.status(upstream.status);
    upstream.headers.forEach((value, key) => {
        if (!["content-encoding", "transfer-encoding", "connection"].includes(key.toLowerCase())) res.setHeader(key, value);
    });
    if (upstream.body) Readable.fromWeb(upstream.body as never).pipe(res);
    else res.end();
}));

app.use((_req, _res, next) => next(Object.assign(new Error("API not found"), { status: 404 })));
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const item = error as { status?: number; code?: string; message?: string; name?: string; meta?: { table?: string } };
    const missingTableName = String(item.meta?.table || item.message || "");
    const missingProductTable = item.code === "P2021" && /products|product_media/i.test(missingTableName);
    const missingDetailPageTable = item.code === "P2021" && /detail_page_projects|detail_page_pairs|detail_page_pair_variants|detail_page_templates|detail_page_template_references|main_image_replication_projects|main_image_replication_pairs|main_image_replication_variants|main_image_replication_templates|main_image_replication_template_references/i.test(missingTableName);
    const missingTable = missingProductTable || missingDetailPageTable;
    const notFound = item.code === "P2025" || item.name === "NotFoundError";
    const status = missingTable ? 503 : item.status || (item.name === "ZodError" ? 400 : notFound ? 404 : 500);
    const message = missingProductTable ? "商品图数据库未初始化，请先执行数据库同步" : missingDetailPageTable ? "详情页复刻数据库未初始化，请先执行数据库同步" : notFound ? "请求的资源不存在" : item.message || "Server error";
    if (status >= 500) console.error(error);
    res.status(status).json({ error: message, code: item.code });
});

export async function start() {
    await prisma.$connect();
    await seedRoot();
    await ensureBucket();
    app.listen(env.PORT, "0.0.0.0", () => console.log(`Infinite Canvas API listening on :${env.PORT}`));
}

if (process.env.NODE_ENV !== "test") void start().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

export { app };

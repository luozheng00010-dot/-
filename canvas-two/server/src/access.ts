import type { User } from "@prisma/client";
import type { NextFunction, Request, Response } from "express";
import { prisma } from "./db.js";
import { hashToken, SESSION_COOKIE } from "./security.js";

declare global {
    namespace Express {
        interface Request {
            user?: User;
            sessionId?: string;
        }
    }
}

export async function loadSession(req: Request, _res: Response, next: NextFunction) {
    try {
        const token = req.cookies?.[SESSION_COOKIE];
        if (!token) return next();
        const session = await prisma.session.findUnique({ where: { tokenHash: hashToken(token) }, include: { user: true } });
        if (!session || session.expiresAt <= new Date() || session.user.deletedAt) return next();
        req.user = session.user;
        req.sessionId = session.id;
        next();
    } catch (error) {
        next(error);
    }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
    if (!req.user) return next(Object.assign(new Error("请先登录"), { status: 401 }));
    next();
}

export function requireReadyUser(req: Request, _res: Response, next: NextFunction) {
    if (!req.user) return next(Object.assign(new Error("请先登录"), { status: 401 }));
    if (req.user.mustChangePassword) return next(Object.assign(new Error("请先修改初始密码"), { status: 428, code: "PASSWORD_CHANGE_REQUIRED" }));
    next();
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
    if (!req.user) return next(Object.assign(new Error("请先登录"), { status: 401 }));
    if (req.user.mustChangePassword) return next(Object.assign(new Error("请先修改初始密码"), { status: 428, code: "PASSWORD_CHANGE_REQUIRED" }));
    if (req.user.role !== "admin") return next(Object.assign(new Error("仅管理员可执行此操作"), { status: 403 }));
    next();
}

export type AccessLevel = "view" | "edit";

export async function accessLevel(user: User, ownerId: string): Promise<AccessLevel | null> {
    if (user.role === "admin" || user.id === ownerId) return "edit";
    const permission = await prisma.memberPermission.findUnique({ where: { granteeId_targetId: { granteeId: user.id, targetId: ownerId } }, include: { target: true } });
    if (!permission || permission.target.deletedAt) return null;
    return permission.level === "edit" ? "edit" : "view";
}

export async function assertAccess(user: User, ownerId: string, required: AccessLevel) {
    const level = await accessLevel(user, ownerId);
    if (!level || (required === "edit" && level !== "edit")) throw Object.assign(new Error(required === "edit" ? "没有编辑该成员数据的权限" : "没有查看该成员数据的权限"), { status: 403 });
    return level;
}

export async function accessibleOwnerIds(user: User, scope?: string) {
    if (scope && scope !== "self" && scope !== "all") {
        await assertAccess(user, scope, "view");
        return [scope];
    }
    if (scope !== "all") return [user.id];
    if (user.role === "admin") return (await prisma.user.findMany({ where: { deletedAt: null }, select: { id: true } })).map((item) => item.id);
    const grants = await prisma.memberPermission.findMany({ where: { granteeId: user.id, target: { deletedAt: null } }, select: { targetId: true } });
    return [user.id, ...grants.map((item) => item.targetId)];
}

export function publicUser(user: User) {
    return { id: user.id, username: user.username, role: user.role, mustChangePassword: user.mustChangePassword };
}

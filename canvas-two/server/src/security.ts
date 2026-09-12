import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import argon2 from "argon2";
import type { Response } from "express";
import { env, isProduction, publicBasePath } from "./config.js";

export const SESSION_COOKIE = "canvas_session";
const SESSION_DAYS = 30;
const usernamePattern = /^[\p{Script=Han}A-Za-z]{1,10}$/u;

export function normalizeUsername(username: string) {
    return username.trim().toLocaleLowerCase("en-US");
}

export function assertUsername(username: string) {
    const value = username.trim();
    if (!usernamePattern.test(value)) throw Object.assign(new Error("账号名必须为 1-10 个中文或英文字母"), { status: 400 });
    return value;
}

export function assertPassword(password: string, bootstrap = false) {
    if (!bootstrap && (password.length < 8 || password.length > 72)) throw Object.assign(new Error("密码长度必须为 8-72 位"), { status: 400 });
    return password;
}

export function hashPassword(password: string) {
    return argon2.hash(password, { type: argon2.argon2id });
}

export function verifyPassword(hash: string, password: string) {
    return argon2.verify(hash, password);
}

export function newSessionToken() {
    return randomBytes(32).toString("base64url");
}

export function hashToken(token: string) {
    return createHash("sha256").update(`${env.SESSION_SECRET}:${token}`).digest("hex");
}

export function sessionExpiry() {
    return new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
}

export function setSessionCookie(res: Response, token: string, expires: Date) {
    res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax", secure: isProduction, path: publicBasePath || "/", expires });
}

export function clearSessionCookie(res: Response) {
    res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: "lax", secure: isProduction, path: publicBasePath || "/" });
}

function encryptionKey() {
    return createHash("sha256").update(env.CHANNEL_ENCRYPTION_KEY).digest();
}

export function encryptSecret(value: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return [iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}

export function decryptSecret(value: string) {
    const [iv, tag, encrypted] = value.split(".");
    if (!iv || !tag || !encrypted) throw new Error("模型渠道密钥格式不正确");
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8");
}

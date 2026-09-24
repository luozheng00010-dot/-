import { Readable } from "node:stream";
import type { Request, Response } from "express";
import { request, Agent, FormData } from "undici";
import { env } from "../config.js";

const base = env.AUTO_VIDEO_API_URL.replace(/\/+$/, "");
const dispatcher = new Agent({ bodyTimeout: 0, headersTimeout: 180_000 });
export async function semanticEngine<T>(path: string, body: unknown): Promise<T> {
    let response;
    try {
        response = await request(`${base}/api/v1/semantic${path}`, { method: "POST", headersTimeout: 1_800_000, bodyTimeout: 0, headers: { "content-type": "application/json", "x-api-key": env.AUTO_VIDEO_API_KEY }, body: JSON.stringify(body) });
    } catch { throw Object.assign(new Error("剪辑引擎连接失败，请启动引擎后重试"), { status: 503 }); }
    let data: any;
    try { data = await response.body.json(); } catch { throw Object.assign(new Error("引擎未返回有效结果，请检查引擎日志"), { status: response.statusCode >= 500 ? 503 : 422 }); }
    if (response.statusCode >= 400) throw Object.assign(new Error(typeof data.detail === "string" ? data.detail : data.message || "引擎参数或媒体处理失败"), { status: response.statusCode >= 500 ? 503 : 422 });
    return data as T;
}

export async function uploadEngineFile(file: Express.Multer.File, folder?: string): Promise<string> {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(file.buffer)], { type: "application/octet-stream" }), file.originalname);
    if (folder?.trim()) form.append("folder", folder.trim().slice(0, 80));
    let upstream;
    try {
        upstream = await request(`${base}/api/v1/library-videos`, { method: "POST", dispatcher, headers: { "x-api-key": env.AUTO_VIDEO_API_KEY }, body: form });
    } catch {
        throw Object.assign(new Error("自动剪辑引擎不可用，视频上传失败"), { status: 503 });
    }
    const body = await upstream.body.json() as { data?: { file?: string }; message?: string; detail?: string };
    if (upstream.statusCode !== 200 || !body.data?.file) throw Object.assign(new Error(body.message || body.detail || "视频校验或上传失败"), { status: upstream.statusCode >= 400 ? upstream.statusCode : 502 });
    return body.data.file;
}

export async function removeEngineUpload(key: string) {
    const upstream = await request(`${base}/api/v1/library-videos/${encodeURIComponent(key)}`, { method: "DELETE", dispatcher, headers: { "x-api-key": env.AUTO_VIDEO_API_KEY } });
    await upstream.body.dump();
    if (upstream.statusCode >= 400) throw new Error("清理失败");
}

export type MaterialStorageSettings = { dir: string; default_dir: string; custom: boolean };

async function storageRequest(method: string, body?: unknown): Promise<MaterialStorageSettings> {
    let upstream;
    try {
        upstream = await request(`${base}/api/v1/storage`, { method: method as "GET" | "PUT", dispatcher, headers: { "x-api-key": env.AUTO_VIDEO_API_KEY, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
        throw Object.assign(new Error("自动剪辑引擎不可用，无法管理素材存储位置"), { status: 503 });
    }
    let payload: any;
    try { payload = await upstream.body.json(); } catch { throw Object.assign(new Error("引擎存储配置响应无效"), { status: 502 }); }
    if (upstream.statusCode >= 400) throw Object.assign(new Error(payload?.data?.message || payload?.message || "素材存储位置不可用"), { status: upstream.statusCode >= 500 ? 503 : 400 });
    return payload?.data ?? payload;
}

export const getEngineStorage = () => storageRequest("GET");
/** dir 传 null 或空字符串表示恢复默认存储位置。 */
export const setEngineStorage = (dir: string | null) => storageRequest("PUT", { dir: dir || "" });

export async function forwardStream(req: Request, res: Response, path: string) {
    try {
        const upstream = await request(`${base}${path}`, { dispatcher, headers: { "x-api-key": env.AUTO_VIDEO_API_KEY, ...(req.headers.range ? { range: req.headers.range } : {}) } });
        res.status(upstream.statusCode);
        for (const name of ["content-type", "content-length", "content-range", "accept-ranges"]) {
            const value = upstream.headers[name];
            if (value !== undefined) res.setHeader(name, value);
        }
        const stream = Readable.from(upstream.body);
        res.on("close", () => stream.destroy());
        stream.on("error", () => res.destroy());
        stream.pipe(res);
    } catch {
        res.status(503).json({ error: "自动剪辑引擎不可用，无法播放视频" });
    }
}

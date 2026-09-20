import fs from "node:fs/promises";
import path from "node:path";
import { Router, type Response } from "express";
import multer from "multer";
import { request as undiciRequest, Agent, FormData as UndiciFormData } from "undici";
import { requireReadyUser } from "../access.js";
import { env } from "../config.js";
import { autoVideoSettingsRouter } from "./models.js";
import { semanticRouter } from "./semantic-routes.js";

/**
 * 自动剪辑模块（MoneyPrinterTurbo）代理层。
 * 前端只访问 /api/auto-video/*，由这里转发到独立的 Python FastAPI 服务
 * （默认 http://127.0.0.1:8080），避免浏览器跨域，也便于统一登录态。
 */

const router = Router();
router.use(requireReadyUser);
router.use("/admin/settings", autoVideoSettingsRouter);
router.use(semanticRouter);

const upstreamBase = env.AUTO_VIDEO_API_URL.replace(/\/+$/, "");
const dispatcher = new Agent({ bodyTimeout: 0, headersTimeout: 30_000 });

const autoVideoDir = path.resolve(process.cwd(), env.AUTO_VIDEO_DIR);

function upstreamError(res: Response, error: unknown) {
    const message = error instanceof Error && error.message.includes("ECONNREFUSED") ? "自动剪辑服务未启动" : "自动剪辑服务请求失败";
    res.status(503).json({ error: message });
}

/** 转发简单 JSON/空体请求并把上游 {status, message, data} 信封原样返回 */
async function forwardJson(res: Response, method: "GET" | "POST", upstreamPath: string) {
    try {
        const upstream = await undiciRequest(`${upstreamBase}${upstreamPath}`, {
            method,
            dispatcher,
            headers: { "x-api-key": env.AUTO_VIDEO_API_KEY },
        });
        const text = await upstream.body.text();
        res.status(upstream.statusCode).type("json").send(text || "{}");
    } catch (error) {
        upstreamError(res, error);
    }
}

// 服务健康：上游 /ping 返回 "pong"
router.get("/health", async (_req, res) => {
    try {
        const upstream = await undiciRequest(`${upstreamBase}/ping`, { method: "GET", dispatcher });
        const text = await upstream.body.text();
        res.json({ status: upstream.statusCode === 200 ? "up" : "down" });
    } catch {
        res.json({ status: "down" });
    }
});

// 音色清单：直接读 Python 侧内置的 azure_voices.json，避免在前端维护副本
const FALLBACK_VOICES = [
    { name: "zh-CN-XiaoxiaoNeural", gender: "Female" },
    { name: "zh-CN-YunxiNeural", gender: "Male" },
    { name: "zh-CN-YunxiaNeural", gender: "Male" },
    { name: "zh-CN-XiaoyiNeural", gender: "Female" },
    { name: "zh-CN-YunjianNeural", gender: "Male" },
    { name: "en-US-AriaNeural", gender: "Female" },
    { name: "en-US-GuyNeural", gender: "Male" },
];
router.get("/voices", async (_req, res) => {
    try {
        const file = await fs.readFile(path.join(autoVideoDir, "app", "services", "data", "azure_voices.json"), "utf8");
        res.json(JSON.parse(file));
    } catch {
        res.json(FALLBACK_VOICES);
    }
});

// 字体清单：resource/fonts 目录文件名
const FALLBACK_FONTS = ["MicrosoftYaHeiBold.ttc", "MicrosoftYaHeiNormal.ttc", "STHeitiLight.ttc", "STHeitiMedium.ttc"];
router.get("/fonts", async (_req, res) => {
    try {
        const dir = await fs.readdir(path.join(autoVideoDir, "resource", "fonts"));
        const fonts = dir.filter((name) => /\.(ttf|ttc|otf)$/i.test(name));
        res.json(fonts.length ? fonts : FALLBACK_FONTS);
    } catch {
        res.json(FALLBACK_FONTS);
    }
});

// BGM 清单（本地视频统一使用 /api/local-materials）
router.get("/musics", async (_req, res) => {
    await forwardJson(res, "GET", "/api/v1/musics");
});

// BGM 上传转发（multipart，交给引擎校验和落盘）
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } });
async function forwardUpload(res: Response, upstreamPath: string, file?: Express.Multer.File) {
    if (!file) {
        res.status(400).json({ error: "缺少文件" });
        return;
    }
    try {
        const form = new UndiciFormData();
        form.append("file", new Blob([new Uint8Array(file.buffer)], { type: file.mimetype || "application/octet-stream" }), file.originalname);
        const upstream = await undiciRequest(`${upstreamBase}${upstreamPath}`, { method: "POST", dispatcher, headers: { "x-api-key": env.AUTO_VIDEO_API_KEY }, body: form });
        const text = await upstream.body.text();
        res.status(upstream.statusCode).type("json").send(text || "{}");
    } catch (error) {
        upstreamError(res, error);
    }
}
router.post("/musics/upload", upload.single("file"), async (req, res) => {
    await forwardUpload(res, "/api/v1/musics", req.file);
});

export const autoVideoRouter = router;

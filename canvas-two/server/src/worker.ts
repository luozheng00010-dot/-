import { createServer } from "node:http";
import type { Prisma } from "@prisma/client";
import { mergeUpstreamUrl, safeUpstreamError } from "./ai-utils.js";
import { env, publicBasePath } from "./config.js";
import { prisma } from "./db.js";
import { mediaBuffer, storeGeneratedImages } from "./media.js";
import { decryptSecret } from "./security.js";
import { ensureBucket, removeObject } from "./storage.js";
import { configureWorkerProxy } from "./worker-proxy.js";
import { mainImageReplicationContext, markMainImageReplicationRunning, saveMainImageReplicationResult } from "./main-image-replications.js";
import { startKbIndexer, stopKbIndexer } from "./kb/indexer.js";
import { startVideoIngest, stopVideoIngest } from "./video/ingest.js";
import { startVideoExport, stopVideoExport } from "./video/export.js";

type TaskResult = { index: number; status: "queued" | "running" | "succeeded" | "failed"; mediaId?: string; width?: number; height?: number; error?: string };
type TaskReference = { mediaId: string; name?: string; type?: string };
type TaskParameters = { quality?: string; size?: string; resolution?: string; background?: string };
const IMAGE_SIZE_STEP = 16;
const DEFAULT_IMAGE_SHORT_SIDE = 1024;
const IMAGE_MAX_RATIO = 3;
const QUALITY_BASE: Record<string, number> = { low: 1024, medium: 2048, high: 2880, standard: 1024, hd: 2048, "1k": 1024, "2k": 2048, "4k": 2880 };
const GEMINI_RATIOS = ["1:1", "1:4", "1:8", "2:3", "3:2", "3:4", "4:1", "4:3", "4:5", "5:4", "8:1", "9:16", "16:9", "21:9"];
let stopping = false;
let healthy = false;
const processingTaskIds = new Set<string>();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const json = (value: unknown) => value as Prisma.InputJsonValue;
function productIdFromContext(context: unknown) {
    if (!context || typeof context !== "object" || Array.isArray(context)) return undefined;
    const value = context as Record<string, unknown>;
    return value.origin === "product" && typeof value.productId === "string" ? value.productId : undefined;
}
function detailPageContext(context: unknown) {
    if (!context || typeof context !== "object" || Array.isArray(context)) return undefined;
    const value = context as Record<string, unknown>;
    return value.origin === "detail-page" && typeof value.detailPageProjectId === "string" && typeof value.pairId === "string"
        ? { projectId: value.detailPageProjectId, pairId: value.pairId, variantId: typeof value.variantId === "string" ? value.variantId : undefined }
        : undefined;
}
function publicTaskError(error: unknown) {
    const message = error instanceof Error ? error.message.trim() : "";
    return message && /[\u4e00-\u9fff]/.test(message) ? message.slice(0, 500) : "图片生成或保存失败，请稍后重试";
}

function parseRatioValue(value?: string) {
    if (!value) return undefined;
    const match = value.trim().match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
    if (!match) return undefined;
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return undefined;
    return { width, height };
}

function parseRatio(value?: string) {
    const ratio = parseRatioValue(value);
    return ratio && Math.max(ratio.width, ratio.height) / Math.min(ratio.width, ratio.height) <= IMAGE_MAX_RATIO ? ratio : undefined;
}

function upstreamPixelSize(size?: string, quality?: string) {
    const ratio = parseRatio(size);
    if (!ratio) return size;
    const base = QUALITY_BASE[quality?.trim().toLowerCase() || ""];
    const longRatio = Math.max(ratio.width, ratio.height) / Math.min(ratio.width, ratio.height);
    const longSide = base
        ? Math.floor(Math.sqrt(base * base * longRatio) / IMAGE_SIZE_STEP) * IMAGE_SIZE_STEP
        : Math.round(DEFAULT_IMAGE_SHORT_SIDE * longRatio / IMAGE_SIZE_STEP) * IMAGE_SIZE_STEP;
    const shortSide = Math.max(IMAGE_SIZE_STEP, Math.round(longSide / longRatio / IMAGE_SIZE_STEP) * IMAGE_SIZE_STEP);
    return ratio.width >= ratio.height ? `${longSide}x${shortSide}` : `${shortSide}x${longSide}`;
}

function geminiAspectRatio(size?: string) {
    const dimensions = size?.trim().match(/^(\d+)x(\d+)$/i);
    const ratio = dimensions ? { width: Number(dimensions[1]), height: Number(dimensions[2]) } : parseRatio(size);
    if (!ratio) return undefined;
    const target = ratio.width / ratio.height;
    return GEMINI_RATIOS.reduce((best, value) => {
        const current = parseRatioValue(value)!;
        const selected = parseRatioValue(best)!;
        return Math.abs(current.width / current.height - target) < Math.abs(selected.width / selected.height - target) ? value : best;
    });
}

function arkImagePath(baseUrl: string) {
    const path = new URL(baseUrl).pathname.replace(/\/+$/, "").toLowerCase();
    if (path.endsWith("/api/plan/v3")) return "/api/plan/v3/images/generations";
    if (path.endsWith("/api/v3")) return "/api/v3/images/generations";
    return "/v1/images/generations";
}

async function claimTask() {
    return prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM image_generation_tasks WHERE status = 'queued' ORDER BY created_at ASC FOR UPDATE SKIP LOCKED LIMIT 1`;
        if (!rows[0]) return null;
        return tx.imageGenerationTask.update({ where: { id: rows[0].id }, data: { status: "running", startedAt: new Date(), heartbeatAt: new Date(), attempt: { increment: 1 } }, include: { channel: true } });
    });
}

async function readPayload(response: Response, apiKey: string) {
    const text = await response.text();
    let payload: any;
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = null; }
    if (!response.ok) throw new Error(safeUpstreamError(payload, text || response.statusText, response.status, apiKey, "生图服务请求失败"));
    if (!payload) throw new Error("生图服务返回了无法解析的数据，请检查渠道接口兼容性");
    return payload;
}

async function requestSlot(task: any, apiKey: string) {
    const parameters = (task.parameters || {}) as TaskParameters;
    const requestSize = task.channel.apiFormat === "gemini" ? parameters.size : upstreamPixelSize(parameters.size, parameters.quality);
    const references = (Array.isArray(task.references) ? task.references : []) as TaskReference[];
    const loaded = await Promise.all(references.map(async (reference) => ({ reference, ...(await mediaBuffer(reference.mediaId)) })));
    const mask = task.maskMediaId ? await mediaBuffer(task.maskMediaId) : undefined;
    if (mask && task.channel.apiFormat === "gemini") throw new Error("Gemini 调用格式暂不支持蒙版编辑");
    if (mask && task.channel.apiFormat === "ark") throw new Error("火山方舟图片接口暂不支持蒙版编辑");
    const headers: Record<string, string> = task.channel.apiFormat === "gemini" ? { "x-goog-api-key": apiKey, "content-type": "application/json" } : { authorization: `Bearer ${apiKey}` };
    let url: URL;
    let body: BodyInit;
    if (task.channel.apiFormat === "gemini") {
        url = mergeUpstreamUrl(task.channel.baseUrl, `/v1beta/models/${encodeURIComponent(task.model)}:generateContent`);
        url.searchParams.set("key", apiKey);
        const parts: any[] = [{ text: task.requestPrompt }, ...loaded.map(({ item, buffer }) => ({ inlineData: { mimeType: item.mimeType, data: buffer.toString("base64") } }))];
        const image: Record<string, string> = {};
        const aspectRatio = geminiAspectRatio(parameters.size);
        if (aspectRatio) image.aspectRatio = aspectRatio;
        const geminiSize = parameters.resolution || parameters.quality;
        if (geminiSize) image.imageSize = geminiSize === "4k" || geminiSize === "high" ? "4K" : geminiSize === "2k" || geminiSize === "medium" || geminiSize === "hd" ? "2K" : "1K";
        body = JSON.stringify({ contents: [{ role: "user", parts }], generationConfig: { responseModalities: ["TEXT", "IMAGE"], ...(Object.keys(image).length ? { responseFormat: { image } } : {}) } });
    } else if (task.channel.apiFormat === "ark" && loaded.length) {
        url = mergeUpstreamUrl(task.channel.baseUrl, arkImagePath(task.channel.baseUrl));
        headers["content-type"] = "application/json";
        body = JSON.stringify({ model: task.model, prompt: task.requestPrompt, n: 1, response_format: "b64_json", output_format: "png", image: loaded.map(({ item, buffer }) => `data:${item.mimeType};base64,${buffer.toString("base64")}`), ...(parameters.quality ? { quality: parameters.quality } : {}), ...(requestSize ? { size: requestSize } : {}), ...(parameters.background ? { background: parameters.background } : {}) });
    } else if (loaded.length) {
        url = mergeUpstreamUrl(task.channel.baseUrl, "/v1/images/edits");
        const form = new FormData();
        form.set("model", task.model);
        form.set("prompt", task.requestPrompt);
        form.set("n", "1");
        form.set("response_format", "b64_json");
        form.set("output_format", "png");
        if (parameters.quality) form.set("quality", parameters.quality);
        if (requestSize) form.set("size", requestSize);
        if (parameters.background) form.set("background", parameters.background);
        loaded.forEach(({ item, buffer }, index) => form.append("image", new Blob([new Uint8Array(buffer)], { type: item.mimeType }), `reference-${index + 1}`));
        if (mask) form.set("mask", new Blob([new Uint8Array(mask.buffer)], { type: mask.item.mimeType }), "mask");
        body = form;
    } else {
        url = mergeUpstreamUrl(task.channel.baseUrl, task.channel.apiFormat === "ark" ? arkImagePath(task.channel.baseUrl) : "/v1/images/generations");
        headers["content-type"] = "application/json";
        body = JSON.stringify({ model: task.model, prompt: task.requestPrompt, n: 1, response_format: "b64_json", output_format: "png", ...(parameters.quality ? { quality: parameters.quality } : {}), ...(requestSize ? { size: requestSize } : {}), ...(parameters.background ? { background: parameters.background } : {}) });
    }
    let response: Response;
    try { response = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(15 * 60_000) }); }
    catch (error) { throw new Error(error instanceof DOMException && error.name === "TimeoutError" ? "生图请求超过 15 分钟，已停止等待" : "无法连接模型服务，请检查管理员渠道请求地址、网络或服务状态"); }
    return readPayload(response, apiKey);
}

async function saveProgress(task: any, results: TaskResult[]) {
    const completedCount = results.filter((item) => item.status === "succeeded" || item.status === "failed").length;
    await prisma.imageGenerationTask.update({ where: { id: task.id }, data: { completedCount, results: json(results), heartbeatAt: new Date() } });
}

async function saveWorkbenchHistory(task: any, results: TaskResult[], status: string) {
    if ((task.context as any)?.origin !== "workbench") return;
    const success = results.filter((item) => item.status === "succeeded");
    const mediaIds = success.map((item) => item.mediaId!).filter(Boolean);
    const media = mediaIds.length ? await prisma.mediaFile.findMany({ where: { id: { in: mediaIds } } }) : [];
    const map = new Map(media.map((item) => [item.id, item]));
    const images = success.flatMap((result) => {
        const item = result.mediaId ? map.get(result.mediaId) : undefined;
        return item ? [{ id: item.id, dataUrl: `${publicBasePath}/api/media/${item.id}/content`, thumbnailUrl: `${publicBasePath}/api/media/${item.id}/thumbnail`, storageKey: `media:${item.id}`, width: result.width || 0, height: result.height || 0, bytes: Number(item.bytes), mimeType: item.mimeType, durationMs: task.startedAt ? Date.now() - new Date(task.startedAt).getTime() : 0 }] : [];
    });
    const now = Date.now();
    const payload = { id: task.clientRequestId, createdAt: now, title: task.prompt.slice(0, 30), prompt: task.prompt, time: new Date(now).toLocaleString("zh-CN"), model: task.model, config: { model: task.model, imageModel: task.model, quality: (task.parameters as any)?.quality || "auto", size: (task.parameters as any)?.size || "auto", count: String(task.totalCount) }, references: [], durationMs: task.startedAt ? now - new Date(task.startedAt).getTime() : 0, successCount: success.length, failCount: task.totalCount - success.length, imageCount: success.length, size: (task.parameters as any)?.size || "auto", quality: (task.parameters as any)?.quality || "auto", status: success.length ? "成功" : "失败", images, thumbnails: images.map((image) => image.thumbnailUrl), taskId: task.id };
    await prisma.workbenchGeneration.upsert({ where: { ownerId_kind_legacyId: { ownerId: task.ownerId, kind: "image", legacyId: task.id } }, create: { ownerId: task.ownerId, createdById: task.createdById, updatedById: task.createdById, kind: "image", title: task.prompt.slice(0, 200), status, legacyId: task.id, payload: json(payload) }, update: { status, payload: json(payload), updatedById: task.createdById } });
}

async function markProductRunning(task: any) {
    const productId = productIdFromContext(task.context);
    if (!productId) return;
    await prisma.product.updateMany({ where: { id: productId, activeTaskId: task.id }, data: { status: "running", error: null, updatedById: task.createdById, revision: { increment: 1 } } });
}
async function markDetailPageRunning(task: any) {
    const context = detailPageContext(task.context);
    if (!context) return;
    await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "detail_page_projects" WHERE id = ${context.projectId} FOR UPDATE`;
        if (context.variantId) await tx.detailPagePairVariant.updateMany({ where: { id: context.variantId, pairId: context.pairId, activeTaskId: task.id }, data: { status: "running", error: null, revision: { increment: 1 } } });
        else await tx.detailPagePair.updateMany({ where: { id: context.pairId, projectId: context.projectId, activeTaskId: task.id }, data: { status: "running", error: null, revision: { increment: 1 } } });
    });
}

async function saveProductResult(task: any, results: TaskResult[], error?: string | null) {
    const productId = productIdFromContext(task.context);
    if (!productId) return;
    const success = results.find((item) => item.status === "succeeded" && item.mediaId);
    await prisma.$transaction(async (tx) => {
        const product = await tx.product.findFirst({ where: { id: productId, activeTaskId: task.id } });
        if (!product) return;
        if (success?.mediaId) {
            await tx.productMedia.deleteMany({ where: { productId, role: "result" } });
            await tx.productMedia.create({ data: { productId, mediaId: success.mediaId, role: "result", sortOrder: 0 } });
        }
        await tx.product.update({
            where: { id: productId },
            data: {
                activeTaskId: null,
                status: success ? "succeeded" : "failed",
                error: success ? null : error || results.find((item) => item.error)?.error || "商品图生成失败",
                updatedById: task.createdById,
                revision: { increment: 1 },
            },
        });
    });
}
async function discardGeneratedMedia(mediaIds: string[]) {
    const ids = [...new Set(mediaIds.filter(Boolean))];
    if (!ids.length) return;
    const media = await prisma.mediaFile.findMany({ where: { id: { in: ids } }, select: { id: true, objectKey: true, thumbnailObjectKey: true } });
    await Promise.all(media.flatMap((item) => [removeObject(item.objectKey), ...(item.thumbnailObjectKey ? [removeObject(item.thumbnailObjectKey)] : [])].map((operation) => operation.catch(() => undefined))));
    if (media.length) await prisma.mediaFile.deleteMany({ where: { id: { in: media.map((item) => item.id) } } }).catch(() => undefined);
}

async function saveDetailPageResult(task: any, results: TaskResult[], status: "succeeded" | "partial" | "failed", error?: string | null) {
    const context = detailPageContext(task.context);
    if (!context) return true;
    const success = results.find((item) => item.status === "succeeded" && item.mediaId);
    const taskStatus = success ? "succeeded" : status;
    let accepted = false;
    await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "detail_page_projects" WHERE id = ${context.projectId} FOR UPDATE`;
        const taskUpdated = await tx.imageGenerationTask.updateMany({ where: { id: task.id, status: "running" }, data: { status: taskStatus, results: json(results), completedCount: task.totalCount, error: success ? null : error, completedAt: new Date(), heartbeatAt: new Date() } });
        if (!taskUpdated.count) return;
        if (context.variantId) {
            const variant = await tx.detailPagePairVariant.findFirst({ where: { id: context.variantId, pairId: context.pairId, activeTaskId: task.id } });
            if (!variant) return;
            await tx.detailPagePairVariant.update({ where: { id: variant.id }, data: { activeTaskId: null, mediaId: success?.mediaId || null, status: success ? "succeeded" : "failed", error: success ? null : error || results.find((item) => item.error)?.error || "修改图生成失败", revision: { increment: 1 } } });
            accepted = true;
        }
        const pair = context.variantId ? null : await tx.detailPagePair.findFirst({ where: { id: context.pairId, projectId: context.projectId, activeTaskId: task.id } });
        if (!pair) return accepted;
        await tx.detailPagePair.update({ where: { id: pair.id }, data: { activeTaskId: null, resultMediaId: success?.mediaId || pair.resultMediaId, status: success ? "succeeded" : "failed", error: success ? null : error || results.find((item) => item.error)?.error || "页面生成失败", revision: { increment: 1 } } });
        if (success?.mediaId) {
            await tx.detailPagePairReference.updateMany({ where: { pairId: pair.id, kind: "result" }, data: { selected: false } });
            await tx.detailPagePairReference.upsert({ where: { pairId_mediaId: { pairId: pair.id, mediaId: success.mediaId } }, create: { pairId: pair.id, mediaId: success.mediaId, kind: "result", selected: true, sortOrder: 999 }, update: { kind: "result", selected: true, sortOrder: 999 } });
        }
        const pairs = await tx.detailPagePair.findMany({ where: { projectId: context.projectId } });
        const active = pairs.some((item) => item.status === "queued" || item.status === "running");
        const successCount = pairs.filter((item) => item.status === "succeeded").length;
        const failedCount = pairs.filter((item) => item.status === "failed" || item.status === "interrupted").length;
        const status = active ? "generating" : successCount === pairs.length ? "succeeded" : successCount ? "partial" : failedCount === pairs.length ? "failed" : "partial";
        await tx.detailPageProject.update({ where: { id: context.projectId }, data: { status, error: status === "failed" ? error || "详情页生成失败" : null, updatedById: task.createdById, revision: { increment: 1 } } });
        accepted = true;
    });
    return accepted;
}

async function processTask(task: any) {
    const apiKey = decryptSecret(task.channel.apiKeyEncrypted);
    let results = (Array.isArray(task.results) ? task.results : Array.from({ length: task.totalCount }, (_, index) => ({ index, status: "queued" }))) as TaskResult[];
    const heartbeat = setInterval(() => void prisma.imageGenerationTask.updateMany({ where: { id: task.id, status: "running" }, data: { heartbeatAt: new Date() } }).catch((error) => console.error("[image-worker] heartbeat failed", task.id, error)), 10_000);
    try {
        for (let index = 0; index < task.totalCount; index += 1) {
            results = results.map((item) => item.index === index ? { index, status: "running" } : item);
            await saveProgress(task, results);
            try {
                const payload = await requestSlot(task, apiKey);
                const [image] = await storeGeneratedImages(payload, task.ownerId, task.createdById, 1);
                if (mainImageReplicationContext(task.context) && image.width !== image.height) {
                    await discardGeneratedMedia([image.id]);
                    throw new Error("模型返回的主图不是 1:1 正方形图片，请重试");
                }
                results = results.map((item) => item.index === index ? { index, status: "succeeded", mediaId: image.id, width: image.width, height: image.height } : item);
            } catch (error) {
                results = results.map((item) => item.index === index ? { index, status: "failed", error: publicTaskError(error) } : item);
            }
            await saveProgress(task, results);
        }
        const successCount = results.filter((item) => item.status === "succeeded").length;
        const status = successCount === task.totalCount ? "succeeded" : successCount ? "partial" : "failed";
        const error = status === "failed" ? results.find((item) => item.error)?.error || "全部图片生成失败" : status === "partial" ? "部分图片生成失败" : null;
        await saveWorkbenchHistory(task, results, status);
        await saveProductResult(task, results, error);
        if (detailPageContext(task.context)) {
            const accepted = await saveDetailPageResult(task, results, status, error);
            if (!accepted) await discardGeneratedMedia(results.filter((item) => item.status === "succeeded" && item.mediaId).map((item) => item.mediaId!));
        } else if (mainImageReplicationContext(task.context)) {
            const accepted = await saveMainImageReplicationResult(task, results, status, error);
            if (!accepted) await discardGeneratedMedia(results.filter((item) => item.status === "succeeded" && item.mediaId).map((item) => item.mediaId!));
        } else await prisma.imageGenerationTask.update({ where: { id: task.id }, data: { status, results: json(results), completedCount: task.totalCount, error, completedAt: new Date(), heartbeatAt: new Date() } });
    } finally { clearInterval(heartbeat); }
}

function failUnfinishedResults(task: { results: unknown; totalCount: number }, error: string) {
    const current = Array.isArray(task.results) ? task.results as Array<Record<string, unknown>> : [];
    return Array.from({ length: task.totalCount }, (_, index) => {
        const result = current.find((item) => item.index === index);
        return result?.status === "succeeded" ? result : { index, status: "failed", error };
    }) as TaskResult[];
}

async function failRunningTask(task: any, error: string) {
    const results = failUnfinishedResults(task, error);
    const detail = detailPageContext(task.context);
    if (detail) {
        const accepted = await saveDetailPageResult(task, results, "failed", error);
        if (!accepted) await discardGeneratedMedia(results.filter((item) => item.status === "succeeded" && item.mediaId).map((item) => item.mediaId!));
        return;
    }
    if (mainImageReplicationContext(task.context)) {
        const accepted = await saveMainImageReplicationResult(task, results, "failed", error);
        if (!accepted) await discardGeneratedMedia(results.filter((item) => item.status === "succeeded" && item.mediaId).map((item) => item.mediaId!));
        return;
    }
    const updated = await prisma.imageGenerationTask.updateMany({ where: { id: task.id, status: "running" }, data: { status: "failed", error, results: json(results), completedCount: task.totalCount, completedAt: new Date(), heartbeatAt: new Date() } });
    if (!updated.count) return;
    await saveWorkbenchHistory(task, results, "failed");
    await saveProductResult(task, results, error);
}

async function recoverInterruptedTasks() {
    const processingIds = [...processingTaskIds];
    const tasks = await prisma.imageGenerationTask.findMany({ where: { status: "running", ...(processingIds.length ? { id: { notIn: processingIds } } : {}), OR: [{ heartbeatAt: null }, { heartbeatAt: { lt: new Date(Date.now() - 60_000) } }] } });
    const error = "后台服务重启导致任务中断，请手动重试；系统未自动重新请求模型，以避免重复计费";
    await Promise.all(tasks.map((task) => failRunningTask(task, error)));
}

async function workerLoop() {
    while (!stopping) {
        const task = await claimTask();
        if (!task) { await sleep(1_000); continue; }
        processingTaskIds.add(task.id);
        try {
            await markProductRunning(task);
            await markDetailPageRunning(task);
            await markMainImageReplicationRunning(task);
            await processTask(task);
        }
        catch (error) {
            console.error("[image-worker] task failed", task.id, error);
            await failRunningTask(task, "后台任务执行失败，请手动重试");
        } finally {
            processingTaskIds.delete(task.id);
        }
    }
}

async function start() {
    configureWorkerProxy(env.WORKER_PROXY_URL);
    await prisma.$connect();
    await ensureBucket();
    await recoverInterruptedTasks();
    const recoveryTimer = setInterval(() => void recoverInterruptedTasks().catch((error) => console.error("[image-worker] recovery failed", error)), 30_000);
    recoveryTimer.unref();
    createServer((_req, res) => { res.statusCode = healthy ? 200 : 503; res.end(healthy ? "ok" : "starting"); }).listen(env.WORKER_PORT, "0.0.0.0");
    healthy = true;
    console.log(`Image worker listening on :${env.WORKER_PORT}, concurrency=${env.IMAGE_WORKER_CONCURRENCY}`);
    await Promise.all(Array.from({ length: env.IMAGE_WORKER_CONCURRENCY }, workerLoop));
}

for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => { stopping = true; healthy = false; stopKbIndexer(); stopVideoIngest(); stopVideoExport(); });
void startKbIndexer();
void startVideoIngest();
void startVideoExport();
void start().catch((error) => { console.error(error); process.exitCode = 1; });

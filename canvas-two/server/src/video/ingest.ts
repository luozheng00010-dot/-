import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import sharp from "sharp";
import { z } from "zod";
import { prisma } from "../db.js";
import { getObject, putObject } from "../storage.js";
import { extractMidFrame, probeMedia } from "./ffmpeg.js";
import { visionJson } from "./llm.js";

/**
 * 素材打标 worker（T5，跑在 worker 进程）：
 * 轮询 pending 素材 → MinIO 取原视频 → ffprobe 读时长/宽高 → 抽中间帧 →
 * 压缩缩略图 → VLM 打标 → 回写标签字段，并结算批次计数。
 * 认领模式与 kb/indexer.ts 一致：FOR UPDATE SKIP LOCKED；stop 置位后做完当前条退出。
 */

const POLL_INTERVAL_MS = 5_000;
const CONCURRENCY = 2;
const THUMBNAIL_SHORT_SIDE = 480;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let stopping = false;

export function stopVideoIngest() {
    stopping = true;
}

/** VLM 打标结果 schema：category/shotType/motion 枚举放宽为 string 容错（D5：AI 只做辅助预测） */
const tagResultSchema = z.object({
    category: z.string().trim().min(1).max(30),
    shotType: z.string().trim().min(1).max(30),
    motion: z.string().trim().min(1).max(30),
    productVisible: z.boolean(),
    description: z.string().trim().min(1).max(60, "画面描述不能超过 60 字"),
});

/** 01 文档 §4.1 打标 prompt，{{categories}} 注入数据库动态分类清单 */
export function buildTagPrompt(categoryNames: string[]): string {
    const categories = categoryNames.filter(Boolean).join("/") || "通用";
    return [
        "你是电商视频素材管理员。看这张视频抽帧，输出 JSON：",
        "{",
        `  "category": "文胸|内裤|其他",     // 从给定清单中选：${categories}`,
        `  "shotType": "特写|近景|中景|全景",`,
        `  "motion": "旋转|手持|摆放|穿戴|平铺|使用演示|其他",`,
        `  "productVisible": true|false,     // 画面是否出现可识别的具体产品（内衣本体）`,
        `  "description": "一句话中文画面描述，不超过30字"`,
        "}",
        "只输出 JSON。",
    ].join("\n");
}

/** 人工分类优先（D5）：VLM 分类与素材所属分类不一致时，保留人工分类并在描述末尾追加疑似提示 */
export function mergeTagDescription(description: string, aiCategory: string, humanCategory: string): string {
    const base = description.trim();
    const ai = aiCategory.trim();
    if (!ai || ai === humanCategory.trim()) return base;
    return `${base}（AI 疑似：${ai}）`;
}

/** 批次结算判定：done+failed=total 时定终态（全部成功=done，全部失败=failed，否则 partial） */
export function batchFinalStatus(doneCount: number, failedCount: number, totalCount: number): "processing" | "done" | "partial" | "failed" {
    if (totalCount <= 0 || doneCount + failedCount < totalCount) return "processing";
    if (failedCount === 0) return "done";
    if (doneCount === 0) return "failed";
    return "partial";
}

interface ClaimedMaterial {
    id: string;
    batchId: string | null;
    mediaFileId: string;
    fileName: string;
    category: { name: string } | null;
    batch: { createdById: string } | null;
}

async function claimMaterial(): Promise<ClaimedMaterial | null> {
    return prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM video_materials WHERE tag_status = 'pending' ORDER BY created_at ASC FOR UPDATE SKIP LOCKED LIMIT 1`;
        if (!rows[0]) return null;
        return tx.videoMaterial.update({ where: { id: rows[0].id }, data: { tagStatus: "processing" }, include: { category: true, batch: true } });
    });
}

function tempVideoName(fileName: string): string {
    const ext = /\.([a-z0-9]{1,10})$/i.exec(fileName.trim())?.[1]?.toLowerCase() || "mp4";
    return `source.${ext}`;
}

function thumbnailFileName(fileName: string): string {
    const stem = fileName.replace(/\.[^.]*$/, "").trim().slice(0, 100);
    return `${stem || "material"}.jpg`;
}

/** 抽帧压缩到短边 480 的 jpeg（同一张图也作为 VLM 输入，控制 token 成本） */
async function buildThumbnail(framePath: string): Promise<Buffer> {
    const image = sharp(framePath);
    const metadata = await image.metadata();
    const landscape = (metadata.width ?? 0) >= (metadata.height ?? 0);
    return image
        .resize(landscape ? undefined : THUMBNAIL_SHORT_SIDE, landscape ? THUMBNAIL_SHORT_SIDE : undefined, { withoutEnlargement: true })
        .jpeg({ quality: 82 })
        .toBuffer();
}

async function tagMaterial(material: ClaimedMaterial): Promise<void> {
    if (!material.batch) throw new Error("素材缺少上传批次，无法确定缩略图归属");
    const mediaFile = await prisma.mediaFile.findUnique({ where: { id: material.mediaFileId } });
    if (!mediaFile) throw new Error("找不到素材对应的原视频文件");
    const tempDir = await mkdtemp(join(tmpdir(), "video-tag-"));
    try {
        const videoPath = join(tempDir, tempVideoName(material.fileName));
        await pipeline(await getObject(mediaFile.objectKey) as unknown as Readable, createWriteStream(videoPath));
        const probe = await probeMedia(videoPath);
        const framePath = join(tempDir, "frame.jpg");
        await extractMidFrame(videoPath, framePath, probe.duration / 2);
        const thumbnailBuffer = await buildThumbnail(framePath);

        const objectKey = `video/thumbnails/${randomUUID()}.jpg`;
        await putObject(objectKey, thumbnailBuffer, "image/jpeg");
        const thumbnail = await prisma.mediaFile.create({
            data: {
                ownerId: material.batch.createdById,
                createdById: material.batch.createdById,
                objectKey,
                fileName: thumbnailFileName(material.fileName),
                mimeType: "image/jpeg",
                bytes: BigInt(thumbnailBuffer.length),
                origin: "video",
                visibility: "private",
            },
        });

        const categories = await prisma.videoCategory.findMany({ orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] });
        const prompt = buildTagPrompt(categories.map((item) => item.name));
        const tag = await visionJson(`data:image/jpeg;base64,${thumbnailBuffer.toString("base64")}`, prompt, tagResultSchema);
        const description = mergeTagDescription(tag.description, tag.category, material.category?.name ?? "");

        await prisma.videoMaterial.update({
            where: { id: material.id },
            data: {
                tagStatus: "done",
                tagError: null,
                thumbnailMediaId: thumbnail.id,
                duration: probe.duration,
                width: probe.width,
                height: probe.height,
                description,
                shotType: tag.shotType,
                motion: tag.motion,
                productVisible: tag.productVisible,
            },
        });
    } finally {
        await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
}

/** 单条素材到达终态后原子自增批次计数；done+failed=total 时结算批次状态 */
async function settleBatch(batchId: string, outcome: "done" | "failed"): Promise<void> {
    const updated = await prisma.videoIngestBatch.update({
        where: { id: batchId },
        data: outcome === "done" ? { doneCount: { increment: 1 } } : { failedCount: { increment: 1 } },
    });
    const status = batchFinalStatus(updated.doneCount, updated.failedCount, updated.totalCount);
    if (status !== "processing") {
        await prisma.videoIngestBatch.update({ where: { id: batchId }, data: { status } });
    }
}

async function markFailed(materialId: string, error: unknown): Promise<void> {
    const message = (error instanceof Error ? error.message : "打标失败").slice(0, 500);
    await prisma.videoMaterial.update({ where: { id: materialId }, data: { tagStatus: "failed", tagError: message } })
        .catch((updateError) => console.error("[video-ingest] 写入失败状态出错", materialId, updateError));
}

async function workerLoop(): Promise<void> {
    while (!stopping) {
        const material = await claimMaterial().catch((error) => {
            console.error("[video-ingest] claim failed", error);
            return null;
        });
        if (!material) {
            await sleep(POLL_INTERVAL_MS);
            continue;
        }
        let outcome: "done" | "failed" = "failed";
        try {
            await tagMaterial(material);
            outcome = "done";
            console.log(`[video-ingest] tagged material ${material.id}`);
        } catch (error) {
            console.error("[video-ingest] tag failed", material.id, error);
            await markFailed(material.id, error);
        } finally {
            if (material.batchId) await settleBatch(material.batchId, outcome).catch((error) => console.error("[video-ingest] settle failed", material.batchId, error));
        }
    }
}

export async function startVideoIngest(): Promise<void> {
    console.log("[video-ingest] started");
    // 崩溃恢复：上次进程中断时留在 processing 的素材重新入队
    await prisma.videoMaterial.updateMany({ where: { tagStatus: "processing" }, data: { tagStatus: "pending" } }).catch(() => undefined);
    await Promise.all(Array.from({ length: CONCURRENCY }, () => workerLoop()));
}

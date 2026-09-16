import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Prisma } from "@prisma/client";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { prisma } from "../db.js";
import { getObject, putObject } from "../storage.js";
import { buildAssSubtitle, type SubtitleStyle, type TimelineItem } from "./ass.js";
import { runFfmpeg } from "./ffmpeg.js";

/**
 * ffmpeg 合成导出 worker（T8，跑在 worker 进程，01 文档 §4.4 三步流水线）：
 * ① 逐段标准化（裁剪 + 统一 1080x1920/30fps + 去音轨）→ ② concat 拼接 →
 * ③ 生成 ASS 烧字幕（可选样式/可跳过）→ ④ 旁白/BGM 混音（F2/F3）→ 上传成片 MediaFile。
 * 缺口句（segments 为空 / 素材不可用 / 段处理失败）整句跳过，画面和字幕都不出现，记入 task.params.skipped。
 * 认领模式与 ingest.ts 一致：FOR UPDATE SKIP LOCKED；stop 置位后做完当前条退出。
 */

const POLL_INTERVAL_MS = 5_000;
/** 01 §4.4 第①步：统一竖版 1080x1920、黑边 pad、30fps、yuv420p（素材横竖混合的防变形策略） */
const NORMALIZE_VF = "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,fps=30,setsar=1,format=yuv420p";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let stopping = false;

export function stopVideoExport() {
    stopping = true;
}

// ===== 纯逻辑（供测试） =====

/** concat 清单行：绝对路径 + 单引号包裹，路径内单引号按 ffmpeg concat 转义为 '\''，反斜杠统一为正斜杠 */
export function concatListLine(filePath: string): string {
    const normalized = filePath.replace(/\\/g, "/").replace(/'/g, "'\\''");
    return `file '${normalized}'`;
}

/** ass 滤镜参数必须是**相对文件名**（配合 runFfmpeg 的 cwd）：Windows 盘符冒号会被滤镜解析器当选项分隔符，单引号/反斜杠转义实测均不可靠 */
export function buildBurnArgs(assFileName: string, bodyPath: string, outPath: string): string[] {
    return ["-y", "-progress", "pipe:1", "-i", bodyPath, "-vf", `ass=${assFileName}`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", outPath];
}

/** 进度映射第①②步：完成的段数线性映射到 0-80% */
export function segmentProgress(doneSegments: number, totalSegments: number): number {
    if (totalSegments <= 0) return 80;
    const ratio = Math.min(1, Math.max(0, doneSegments / totalSegments));
    return Math.round(ratio * 80);
}

/** 进度映射第③步：-progress pipe:1 的 out_time_ms（注意该值实际单位是微秒）÷ 成片总时长，映射 80-100% */
export function subtitleProgress(outTimeMicroseconds: number, totalSeconds: number): number {
    if (!(totalSeconds > 0) || !Number.isFinite(outTimeMicroseconds)) return 80;
    const seconds = outTimeMicroseconds / 1_000_000;
    const ratio = Math.min(1, Math.max(0, seconds / totalSeconds));
    return Math.round(80 + ratio * 20);
}

/** DB 进度节流：首次必写；之后变化 ≥2 个百分点，或距上次写入 ≥1s 才写 */
export function shouldWriteProgress(next: number, last: number, elapsedMs: number): boolean {
    if (last < 0) return true;
    if (next === last) return false;
    return next - last >= 2 || elapsedMs >= 1000;
}

export interface SkipDetail {
    sentenceId: number;
    reason: string;
}

/**
 * 素材可用性过滤（句子级原子跳过，保证字幕时间轴与画面同步）：
 * - segments 为空 → 缺口句跳过；
 * - 任一段的素材查不到 / 已归档 / 未完成打标 → 整句跳过（丢段会造成画面与字幕错位）。
 */
export function filterRenderableItems(items: TimelineItem[], availableMaterialIds: Set<string>): { renderable: TimelineItem[]; skips: SkipDetail[] } {
    const renderable: TimelineItem[] = [];
    const skips: SkipDetail[] = [];
    for (const item of items) {
        if (!item.segments.length) {
            skips.push({ sentenceId: item.sentenceId, reason: "缺口句：没有画面段落" });
            continue;
        }
        const missing = item.segments.find((segment) => !availableMaterialIds.has(segment.materialId));
        if (missing) {
            skips.push({ sentenceId: item.sentenceId, reason: `素材不可用（素材 ${missing.materialId} 不存在、已归档或未完成打标）` });
            continue;
        }
        renderable.push(item);
    }
    return { renderable, skips };
}

/** 跳过明细的汇总文案（日志与"全部跳过"失败消息共用） */
export function formatSkipSummary(skips: SkipDetail[]): string {
    if (!skips.length) return "没有跳过的句子";
    return `跳过 ${skips.length} 句：${skips.map((skip) => `第${skip.sentenceId}句`).join("、")}`;
}

/** 时间线 items JSON（Prisma JsonValue）防御性解析为 TimelineItem[]，非法条目/非法段直接丢弃 */
export function parseTimelineItems(value: unknown): TimelineItem[] {
    if (!Array.isArray(value)) return [];
    const items: TimelineItem[] = [];
    for (const entry of value) {
        if (!entry || typeof entry !== "object") continue;
        const raw = entry as Record<string, unknown>;
        const sentenceId = Number(raw.sentenceId);
        const duration = Number(raw.duration);
        if (!Number.isFinite(sentenceId) || !Number.isFinite(duration) || duration < 0) continue;
        const segments = Array.isArray(raw.segments) ? raw.segments.flatMap((segment) => {
            if (!segment || typeof segment !== "object") return [];
            const seg = segment as Record<string, unknown>;
            const materialId = typeof seg.materialId === "string" ? seg.materialId : "";
            const inPoint = Number(seg.inPoint);
            const outPoint = Number(seg.outPoint);
            if (!materialId || !Number.isFinite(inPoint) || !Number.isFinite(outPoint)) return [];
            return [{ materialId, inPoint, outPoint }];
        }) : [];
        items.push({
            sentenceId,
            subtitle: typeof raw.subtitle === "string" ? raw.subtitle : "",
            duration,
            segments,
        });
    }
    return items;
}

/** 成片文件名中的非法字符（Windows 保留字符 + 控制字符）替换为空格并收敛连续空白 */
export function sanitizeFileNamePart(value: string): string {
    return value.replace(/[\u0000-\u001f\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim();
}

// ===== 导出参数（F3：字幕样式 / BGM） =====

export interface ExportParams {
    resolution: string;
    burnSubtitle: boolean;
    subtitleStyle: SubtitleStyle;
    /** BGM asset id（assets/bgm 下 mp3 的去扩展名文件名）；null = 无 BGM */
    bgm: string | null;
    /** BGM 音量（0-1） */
    bgmVolume: number;
}

const DEFAULT_BGM_VOLUME = 0.15;

/** task.params JSON 的防御性解析：字段缺失/非法回落默认值（HTTP 侧已用 zod 校验过一遍） */
export function parseExportParams(raw: unknown): ExportParams {
    const base = (raw && typeof raw === "object" && !Array.isArray(raw)) ? raw as Record<string, unknown> : {};
    return {
        resolution: "1080x1920",
        burnSubtitle: typeof base.burnSubtitle === "boolean" ? base.burnSubtitle : true,
        subtitleStyle: base.subtitleStyle === "highlight" || base.subtitleStyle === "bar" ? base.subtitleStyle : "minimal",
        bgm: typeof base.bgm === "string" && base.bgm.trim() ? base.bgm.trim() : null,
        bgmVolume: typeof base.bgmVolume === "number" && Number.isFinite(base.bgmVolume) ? Math.min(1, Math.max(0, base.bgmVolume)) : DEFAULT_BGM_VOLUME,
    };
}

// ===== BGM 曲库（F3b） =====

export interface BgmAsset {
    /** 去 .mp3 扩展名后的文件名（导出参数 bgm 传它） */
    id: string;
    fileName: string;
}

/** 服务端根目录（src/video 与 dist/video 都在其下三层） */
function serverRoot(): string {
    return resolve(fileURLToPath(new URL("../../../", import.meta.url)));
}

const BGM_ASSETS_DIR = join(serverRoot(), "assets", "bgm");

/** 扫描 assets/bgm 下的 mp3（扩展名不区分大小写，按文件名排序保证清单稳定）；目录不存在返回 [] */
export function listBgmAssets(dir: string = BGM_ASSETS_DIR): BgmAsset[] {
    if (!existsSync(dir)) return [];
    let entries: string[];
    try {
        entries = readdirSync(dir);
    } catch {
        return [];
    }
    return entries
        .filter((name) => name.toLowerCase().endsWith(".mp3"))
        .map((name) => ({ id: name.replace(/\.mp3$/i, ""), fileName: name }))
        .sort((a, b) => (a.fileName < b.fileName ? -1 : a.fileName > b.fileName ? 1 : 0));
}

// ===== 旁白音轨规划（F2 合成改造） =====

/** script.sentences JSON（Prisma JsonValue）防御性解析为 sentenceId → ttsMediaId 映射；无旁白的句子不进 Map */
export function parseSentenceTtsMap(value: unknown): Map<number, string> {
    const map = new Map<number, string>();
    if (!Array.isArray(value)) return map;
    for (const entry of value) {
        if (!entry || typeof entry !== "object") continue;
        const raw = entry as Record<string, unknown>;
        const sentenceId = Number(raw.sentenceId);
        const ttsMediaId = typeof raw.ttsMediaId === "string" ? raw.ttsMediaId : "";
        if (Number.isFinite(sentenceId) && ttsMediaId) map.set(sentenceId, ttsMediaId);
    }
    return map;
}

export interface AudioPlanEntry {
    sentenceId: number;
    /** 该句在成片时间轴上的起点（毫秒取整） = 前序 keptItems duration 累计 */
    startMs: number;
    /** 该句画面时长（毫秒取整） */
    durationMs: number;
    /** 旁白 MediaFile id；无旁白（未生成/失败/句缺）为 null */
    mediaId: string | null;
}

/**
 * 音轨规划（纯函数）：keptItems 是导出依据，句子音频按 sentenceId 对应。
 * 无音句照常占时间轴（画面仍在），只是没有旁白。
 */
export function buildAudioPlan(keptItems: TimelineItem[], audioBySentence: Map<number, string>): AudioPlanEntry[] {
    let cursorMs = 0;
    return keptItems.map((item) => {
        const startMs = cursorMs;
        const durationMs = Math.round(Math.max(0, Number.isFinite(item.duration) ? item.duration : 0) * 1000);
        cursorMs += durationMs;
        return {
            sentenceId: item.sentenceId,
            startMs,
            durationMs,
            mediaId: audioBySentence.get(item.sentenceId) ?? null,
        };
    });
}

export interface MixAudioVoice {
    startMs: number;
    durationMs: number;
    filePath: string;
}

export interface MixAudioOptions {
    bodyPath: string;
    outPath: string;
    voices: MixAudioVoice[];
    bgmPath: string | null;
    bgmVolume: number;
    /** 成片总时长（秒），BGM 截断用 */
    totalSeconds: number;
}

/**
 * 混音命令构造（纯函数）：-i 成片 + 每个有声句一个 -i 本地 mp3 + filter_complex。
 * 每路 [k:a]adelay=startMs|startMs（对齐到全局时间轴）→ atrim=0:句末秒（超过画面时长的旁白截断）
 * → apad（不足补静音，保证 amix 各路等长对齐）；BGM 再加一路 volume+atrim 进 amix；
 * 最后把各路标签显式接进 amix=inputs=N:normalize=0（直接叠加不自动衰减），
 * 输出 -map 0:v -map [aout] -c:v copy -c:a aac -shortest。
 */
export function buildMixAudioArgs(options: MixAudioOptions): string[] {
    const { bodyPath, outPath, voices, bgmPath, bgmVolume, totalSeconds } = options;
    const inputs: string[] = [];
    const filters: string[] = [];
    voices.forEach((voice, index) => {
        inputs.push("-i", voice.filePath);
        const endSeconds = (voice.startMs + voice.durationMs) / 1000;
        filters.push(`[${index + 1}:a]adelay=${voice.startMs}|${voice.startMs},atrim=0:${endSeconds},apad[a${index}]`);
    });
    const mixLabels = voices.map((_voice, index) => `[a${index}]`);
    if (bgmPath) {
        inputs.push("-i", bgmPath);
        const bgmIndex = voices.length + 1;
        const volume = Math.min(1, Math.max(0, Number.isFinite(bgmVolume) ? bgmVolume : DEFAULT_BGM_VOLUME));
        // 毫秒级取整，避免 duration 累加的浮点尾差漏进滤镜参数
        const trimmedSeconds = Math.round(Math.max(0, totalSeconds) * 1000) / 1000;
        filters.push(`[${bgmIndex}:a]volume=${volume},atrim=0:${trimmedSeconds}[abgm]`);
        mixLabels.push("[abgm]");
    }
    filters.push(`${mixLabels.join("")}amix=inputs=${mixLabels.length}:normalize=0[aout]`);
    return [
        "-y",
        "-i", bodyPath,
        ...inputs,
        "-filter_complex", filters.join(";"),
        "-map", "0:v",
        "-map", "[aout]",
        "-c:v", "copy",
        "-c:a", "aac",
        "-shortest",
        outPath,
    ];
}

/** 成片命名（01 §4.4）：{货号}_{标题}_{yyyyMMdd_HHmm}.mp4 */
export function buildExportFileName(sku: string, title: string, now: Date): string {
    const pad = (value: number) => String(value).padStart(2, "0");
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
    const skuPart = sanitizeFileNamePart(sku) || "未命名货号";
    const titlePart = sanitizeFileNamePart(title) || "成片";
    return `${skuPart}_${titlePart}_${stamp}.mp4`;
}

function formatSeconds(value: number): string {
    return String(Math.round(value * 1000) / 1000);
}

function mergeTaskParams(raw: unknown, skips: SkipDetail[]): Prisma.InputJsonValue {
    const base = (raw && typeof raw === "object" && !Array.isArray(raw)) ? raw as Record<string, Prisma.InputJsonValue> : {};
    return { ...base, skipped: skips.map((skip) => ({ sentenceId: skip.sentenceId, reason: skip.reason })) };
}

// ===== worker =====

interface ClaimedTask {
    id: string;
    timelineId: string;
    createdById: string;
    params: unknown;
}

async function claimTask(): Promise<ClaimedTask | null> {
    return prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM video_export_tasks WHERE status = 'queued' ORDER BY created_at ASC FOR UPDATE SKIP LOCKED LIMIT 1`;
        if (!rows[0]) return null;
        const task = await tx.videoExportTask.update({ where: { id: rows[0].id }, data: { status: "running", startedAt: new Date() } });
        return task as unknown as ClaimedTask;
    });
}

interface MaterialSource {
    id: string;
    mediaFileId: string;
    fileName: string;
    objectKey: string;
}

/** 批量取可用素材（status=active 且 tagStatus=done）及其原件 objectKey；查不到的 materialId 不进 Map 即视为不可用 */
async function loadMaterialSources(materialIds: string[]): Promise<Map<string, MaterialSource>> {
    const ids = [...new Set(materialIds.filter(Boolean))];
    if (!ids.length) return new Map();
    const materials = await prisma.videoMaterial.findMany({
        where: { id: { in: ids }, status: "active", tagStatus: "done" },
        select: { id: true, mediaFileId: true, fileName: true },
    });
    if (!materials.length) return new Map();
    const mediaFiles = await prisma.mediaFile.findMany({
        where: { id: { in: [...new Set(materials.map((material) => material.mediaFileId))] } },
        select: { id: true, objectKey: true },
    });
    const objectKeyByMediaId = new Map(mediaFiles.map((media) => [media.id, media.objectKey]));
    const sources = new Map<string, MaterialSource>();
    for (const material of materials) {
        const objectKey = objectKeyByMediaId.get(material.mediaFileId);
        if (objectKey) sources.set(material.id, { id: material.id, mediaFileId: material.mediaFileId, fileName: material.fileName, objectKey });
    }
    return sources;
}

/** DB 进度写入器：节流（变化 ≥2% 或 ≥1s），写失败只记日志不中断合成 */
function createProgressWriter(taskId: string): (value: number) => Promise<void> {
    let last = -1;
    let lastAt = 0;
    return async (value: number) => {
        const next = Math.max(0, Math.min(100, Math.round(value)));
        const now = Date.now();
        if (!shouldWriteProgress(next, last, now - lastAt)) return;
        last = next;
        lastAt = now;
        await prisma.videoExportTask.update({ where: { id: taskId }, data: { progress: next } })
            .catch((error) => console.error("[video-export] 写入进度出错", taskId, error));
    };
}

async function runExportTask(task: ClaimedTask): Promise<void> {
    const timeline = await prisma.videoTimeline.findUnique({ where: { id: task.timelineId }, include: { script: true } });
    if (!timeline) throw new Error("找不到导出任务对应的时间线");
    const items = parseTimelineItems(timeline.items);
    await prisma.videoTimeline.update({ where: { id: timeline.id }, data: { status: "exporting" } }).catch(() => undefined);

    const writeProgress = createProgressWriter(task.id);
    const materials = await loadMaterialSources(items.flatMap((item) => item.segments.map((segment) => segment.materialId)));
    const { renderable, skips } = filterRenderableItems(items, new Set(materials.keys()));
    const totalSegments = renderable.reduce((sum, item) => sum + item.segments.length, 0);
    const keptItems: TimelineItem[] = [];
    const segmentFiles: string[] = [];

    const tempDir = await mkdtemp(join(tmpdir(), "video-export-"));
    try {
        // 同一素材只从 MinIO 下载一次，缓存复用
        const downloadedFiles = new Map<string, string>();
        const ensureMaterialFile = async (materialId: string): Promise<string> => {
            const cached = downloadedFiles.get(materialId);
            if (cached) return cached;
            const source = materials.get(materialId);
            if (!source) throw new Error(`素材 ${materialId} 不可用`);
            const ext = /\.([a-z0-9]{1,10})$/i.exec(source.fileName.trim())?.[1]?.toLowerCase() || "mp4";
            const target = join(tempDir, `source_${materialId}.${ext}`);
            await pipeline(await getObject(source.objectKey) as unknown as Readable, createWriteStream(target));
            downloadedFiles.set(materialId, target);
            return target;
        };

        // ① 逐段标准化；段失败 → 整句跳过，继续后续句子，不整体失败
        let doneSegments = 0;
        for (const item of renderable) {
            const sentenceSegments: string[] = [];
            let failure: string | null = null;
            for (const segment of item.segments) {
                const outputPath = join(tempDir, `seg_${segmentFiles.length + sentenceSegments.length + 1}.mp4`);
                try {
                    const inputPath = await ensureMaterialFile(segment.materialId);
                    const length = Math.max(0.05, segment.outPoint - segment.inPoint);
                    await runFfmpeg([
                        "-y",
                        "-i", inputPath,
                        ...(segment.inPoint > 0 ? ["-ss", formatSeconds(segment.inPoint)] : []),
                        "-t", formatSeconds(length),
                        "-vf", NORMALIZE_VF,
                        "-an",
                        "-c:v", "libx264",
                        "-preset", "veryfast",
                        "-crf", "20",
                        outputPath,
                    ]);
                    sentenceSegments.push(outputPath);
                } catch (error) {
                    failure = `画面段落处理失败：${error instanceof Error ? error.message : String(error)}`;
                    break;
                } finally {
                    doneSegments += 1;
                }
            }
            if (failure) {
                skips.push({ sentenceId: item.sentenceId, reason: failure });
            } else if (sentenceSegments.length) {
                segmentFiles.push(...sentenceSegments);
                keptItems.push(item);
            } else {
                skips.push({ sentenceId: item.sentenceId, reason: "缺口句：没有画面段落" });
            }
            await writeProgress(segmentProgress(doneSegments, totalSegments));
        }

        if (!segmentFiles.length) throw new Error(`没有可用的画面段落，无法合成${skips.length ? `（${formatSkipSummary(skips)}）` : ""}`);

        // ② concat 拼接
        const listPath = join(tempDir, "list.txt");
        await writeFile(listPath, `${segmentFiles.map((file) => concatListLine(file)).join("\n")}\n`, "utf8");
        const bodyPath = join(tempDir, "body.mp4");
        await runFfmpeg(["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", bodyPath]);

        // ③ 生成 ASS 并烧字幕（可按参数跳过）；进度用 out_time_ms（微秒）映射 80-100%
        const exportParams = parseExportParams(task.params);
        const totalSeconds = keptItems.reduce((sum, item) => sum + item.duration, 0);
        let finalPath = bodyPath;
        if (exportParams.burnSubtitle) {
            const assPath = join(tempDir, "subs.ass");
            await writeFile(assPath, buildAssSubtitle(keptItems, exportParams.subtitleStyle), "utf8");
            const burnPath = join(tempDir, "burned.mp4");
            try {
                await runFfmpeg(buildBurnArgs("subs.ass", bodyPath, burnPath), (line) => {
                    const matched = /^\s*out_time_ms=(-?\d+)/.exec(line);
                    if (matched) void writeProgress(subtitleProgress(Number(matched[1]), totalSeconds));
                }, { cwd: tempDir });
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                if (/no such filter|unknown filter|no filter|找不到/i.test(message) && message.toLowerCase().includes("ass")) {
                    throw new Error("当前 ffmpeg 不包含 libass（ass 滤镜不可用），无法烧录字幕，请更换为带 libass 的完整版 ffmpeg 后重试");
                }
                throw error;
            }
            finalPath = burnPath;
        }

        // ④ 旁白/BGM 混音（F2/F3）：有声句 mp3 按 adelay+amix 混成一条音轨再与画面封装；无 tts 且无 bgm 时保持纯视频
        const bgmAsset = exportParams.bgm ? listBgmAssets().find((asset) => asset.id === exportParams.bgm) ?? null : null;
        const voicedPlan = buildAudioPlan(keptItems, parseSentenceTtsMap(timeline.script.sentences)).filter((entry) => entry.mediaId);
        const voices: MixAudioVoice[] = [];
        if (voicedPlan.length) {
            const mediaFiles = await prisma.mediaFile.findMany({
                where: { id: { in: [...new Set(voicedPlan.map((entry) => entry.mediaId as string))] } },
                select: { id: true, objectKey: true },
            });
            const objectKeyByMediaId = new Map(mediaFiles.map((media) => [media.id, media.objectKey]));
            for (const entry of voicedPlan) {
                const objectKey = objectKeyByMediaId.get(entry.mediaId as string);
                if (!objectKey) continue; // 旁白文件丢失：该句静音，不阻断导出
                const target = join(tempDir, `tts_${entry.sentenceId}.mp3`);
                try {
                    await pipeline(await getObject(objectKey) as unknown as Readable, createWriteStream(target));
                } catch (error) {
                    console.error("[video-export] 旁白下载失败，该句静音", entry.sentenceId, error);
                    continue;
                }
                voices.push({ startMs: entry.startMs, durationMs: entry.durationMs, filePath: target });
            }
        }
        if (voices.length || bgmAsset) {
            const outPath = join(tempDir, "out.mp4");
            await runFfmpeg(buildMixAudioArgs({
                bodyPath: finalPath,
                outPath,
                voices,
                bgmPath: bgmAsset ? join(BGM_ASSETS_DIR, bgmAsset.fileName) : null,
                bgmVolume: exportParams.bgmVolume,
                totalSeconds,
            }));
            finalPath = outPath;
        }
        await writeProgress(100);

        // 上传成片：objectKey video/exports/<uuid>.mp4，MediaFile(origin=video, private)，owner/creator=任务创建人
        const outputBuffer = await readFile(finalPath);
        const objectKey = `video/exports/${randomUUID()}.mp4`;
        await putObject(objectKey, outputBuffer, "video/mp4");
        const mediaFile = await prisma.mediaFile.create({
            data: {
                ownerId: task.createdById,
                createdById: task.createdById,
                objectKey,
                fileName: buildExportFileName(timeline.script.sku, timeline.script.title, new Date()),
                mimeType: "video/mp4",
                bytes: BigInt(outputBuffer.length),
                origin: "video",
                visibility: "private",
            },
        });
        await prisma.videoExportTask.update({
            where: { id: task.id },
            data: { status: "succeeded", progress: 100, outputMediaId: mediaFile.id, finishedAt: new Date(), params: mergeTaskParams(task.params, skips) },
        });
        await prisma.videoTimeline.update({ where: { id: timeline.id }, data: { status: "exported" } }).catch(() => undefined);
        console.log(`[video-export] task ${task.id} succeeded -> media ${mediaFile.id}${skips.length ? `（${formatSkipSummary(skips)}）` : ""}`);
    } finally {
        await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
}

async function markExportFailed(task: ClaimedTask, error: unknown): Promise<void> {
    const message = (error instanceof Error ? error.message : "导出失败").slice(0, 500);
    await prisma.videoExportTask.update({ where: { id: task.id }, data: { status: "failed", error: message, finishedAt: new Date() } })
        .catch((updateError) => console.error("[video-export] 写入失败状态出错", task.id, updateError));
    await prisma.videoTimeline.update({ where: { id: task.timelineId }, data: { status: "failed" } }).catch(() => undefined);
}

async function workerLoop(): Promise<void> {
    while (!stopping) {
        const task = await claimTask().catch((error) => {
            console.error("[video-export] claim failed", error);
            return null;
        });
        if (!task) {
            await sleep(POLL_INTERVAL_MS);
            continue;
        }
        try {
            await runExportTask(task);
        } catch (error) {
            console.error("[video-export] task failed", task.id, error);
            await markExportFailed(task, error);
        }
    }
}

export async function startVideoExport(): Promise<void> {
    console.log("[video-export] started");
    // 崩溃恢复：上次进程中断时留在 running 的任务重新入队
    await prisma.videoExportTask.updateMany({ where: { status: "running" }, data: { status: "queued" } }).catch(() => undefined);
    await workerLoop();
}

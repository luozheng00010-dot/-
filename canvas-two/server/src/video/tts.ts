import type { Readable } from "node:stream";
import type { SentencePlan } from "./split.js";

/**
 * TTS 语音合成（F2，02 文档 §2-F2）：基于 msedge-tts（Edge 在线朗读接口，免费、无 key）。
 * 接口签名与后续替换火山引擎 TTS 的适配器兼容（同输入文本 + 音色，返回 mp3 Buffer）。
 * 注意：msedge-tts 用动态 import 触达——包本身不可用时模块加载不受影响，只有真正调用合成才会报错。
 * edge-tts 是非官方接口，偶发限流：内部重试 2 次，失败抛中文错误，由调用方做句级降级。
 */

/** 默认音色：微软晓晓（中文女声，电商旁白通用） */
export const DEFAULT_TTS_VOICE = "zh-CN-XiaoxiaoNeural";

/** 单句合成超时（毫秒） */
const TTS_TIMEOUT_MS = 15_000;
/** 失败后的内部重试次数（不含首次尝试） */
const TTS_RETRIES = 2;
/** 单句文本长度上限（拆句 schema 限 200 字，这里放宽兜底） */
const TTS_MAX_TEXT_LENGTH = 500;
/** 重试前的退避基数：第 1 次重试等 300ms，第 2 次等 600ms */
const RETRY_BACKOFF_MS = 300;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** 收集音频流为 Buffer；超时（Abort 语义由定时器实现）销毁流并抛中文错误 */
function collectAudio(stream: Readable, timeoutMs: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        const timer = setTimeout(() => {
            stream.destroy();
            reject(new Error("语音合成超时，请稍后重试"));
        }, timeoutMs);
        const settle = (action: () => void) => {
            clearTimeout(timer);
            action();
        };
        stream.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        stream.on("end", () => settle(() => resolve(Buffer.concat(chunks))));
        stream.on("error", (error) => settle(() => reject(new Error(`语音服务连接出错：${describeError(error)}`))));
    });
}

/** 单次合成：建连接 → setMetadata(音色/格式) → toStream 收集音频 → 校验非空 */
async function synthesizeOnce(text: string, voice: string, timeoutMs: number): Promise<Buffer> {
    const { MsEdgeTTS, OUTPUT_FORMAT } = await import("msedge-tts");
    const client = new MsEdgeTTS();
    try {
        await client.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
        const { audioStream } = client.toStream(text);
        const mp3 = await collectAudio(audioStream as Readable, timeoutMs);
        if (!mp3.length) throw new Error("语音服务未返回音频数据");
        return mp3;
    } finally {
        client.close();
    }
}

export interface SynthesizeTtsOptions {
    /** 单句超时毫秒数，默认 15000（测试可调小） */
    timeoutMs?: number;
    /** 失败后的重试次数，默认 2 */
    retries?: number;
}

/**
 * 合成单句旁白：返回 mp3 Buffer（时长由调用方用 ffprobe 实测）。
 * 失败重试 2 次（带退避），仍失败抛中文错误。
 */
export async function synthesizeTts(text: string, voice: string = DEFAULT_TTS_VOICE, options: SynthesizeTtsOptions = {}): Promise<{ mp3: Buffer }> {
    const trimmed = text.trim();
    if (!trimmed) throw new Error("合成文本不能为空");
    if (trimmed.length > TTS_MAX_TEXT_LENGTH) throw new Error(`合成文本过长（最多 ${TTS_MAX_TEXT_LENGTH} 字）`);
    const timeoutMs = options.timeoutMs ?? TTS_TIMEOUT_MS;
    const retries = options.retries ?? TTS_RETRIES;
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
        if (attempt > 0) await sleep(RETRY_BACKOFF_MS * attempt);
        try {
            return { mp3: await synthesizeOnce(trimmed, voice, timeoutMs) };
        } catch (error) {
            lastError = error;
        }
    }
    throw new Error(`语音合成失败（已重试 ${retries} 次）：${describeError(lastError)}`);
}

// ===== 句子结果回写（纯函数，供路由与测试复用） =====

/** TTS 生成后的句子形状：在 SentencePlan 上扩展旁白字段（sentences 是 JSON 列，无需迁移） */
export interface TtsSentencePlan extends SentencePlan {
    /** 旁白 MediaFile id；生成失败或未生成为 null */
    ttsMediaId?: string | null;
    /** 旁白实测时长（秒）；失败为 null */
    ttsDuration?: number | null;
    /** 原始字数估算时长（首次生成 TTS 时从 durationHint 备份，重复生成不覆盖） */
    textDurationHint?: number;
}

/** 单句 TTS 处理结果：成功带 mediaId 与实测时长，失败两者为 null */
export interface TtsSentenceResult {
    sentenceId: number;
    mediaId: string | null;
    duration: number | null;
}

/**
 * 把逐句合成结果回写进 sentences：
 * - 成功句：durationHint 改写为实测时长，原始估算保留进 textDurationHint（已存在则不覆盖）；
 * - 失败句：ttsMediaId/ttsDuration 置 null，durationHint 回落到字数估算
 *   （首次生成就失败时本来就是估算值，不动；曾成功过则恢复 textDurationHint）。
 */
export function applyTtsResults(sentences: TtsSentencePlan[], results: TtsSentenceResult[]): TtsSentencePlan[] {
    const resultBySentenceId = new Map(results.map((result) => [result.sentenceId, result]));
    return sentences.map((sentence) => {
        const result = resultBySentenceId.get(sentence.sentenceId);
        if (!result) return sentence; // 没有处理结果的句子原样保留
        const measured = result.duration;
        if (result.mediaId && typeof measured === "number" && Number.isFinite(measured) && measured > 0) {
            return {
                ...sentence,
                textDurationHint: sentence.textDurationHint ?? sentence.durationHint,
                durationHint: Math.round(measured * 100) / 100,
                ttsMediaId: result.mediaId,
                ttsDuration: measured,
            };
        }
        return {
            ...sentence,
            ttsMediaId: null,
            ttsDuration: null,
            ...(typeof sentence.textDurationHint === "number" ? { durationHint: sentence.textDurationHint } : {}),
        };
    });
}

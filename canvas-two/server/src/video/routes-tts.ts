import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Prisma } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { requireReadyUser } from "../access.js";
import { prisma } from "../db.js";
import { putObject } from "../storage.js";
import { probeMedia } from "./ffmpeg.js";
import { applyTtsResults, DEFAULT_TTS_VOICE, synthesizeTts, type TtsSentencePlan, type TtsSentenceResult } from "./tts.js";

/**
 * 自动剪辑 · TTS 旁白接口（F2 的 HTTP 侧）：
 * POST /scripts/:id/tts —— 对已拆句文案逐句生成旁白 mp3（同步，每句约 1-2 秒），
 * ffprobe 实测时长后回写 sentences（durationHint=实测值，原始估算保留进 textDurationHint）。
 * 单句失败不整体失败：该句降级为无旁白（ttsMediaId=null），failedSentenceIds 标注。
 * 响应的 script 序列化形状与 routes-scripts.ts 一致（scriptDto）。
 */

const router = Router();
router.use(requireReadyUser);

const routeParam = (value: string | string[]) => Array.isArray(value) ? value[0] : value;
const json = (value: unknown) => value as Prisma.InputJsonValue;

function scriptDto(script: { id: string; title: string; sku: string; rawText: string; sentences: unknown; status: string }) {
    return {
        id: script.id,
        title: script.title,
        sku: script.sku,
        rawText: script.rawText,
        sentences: (script.sentences ?? null) as TtsSentencePlan[] | null,
        status: script.status,
    };
}

const ttsInput = z.object({
    voice: z.string({ errorMap: () => ({ message: "音色必须是字符串" }) }).trim().min(1, "音色名不能为空").max(60, "音色名最长 60 字符").optional(),
});

router.post("/scripts/:id/tts", async (req, res) => {
    const input = ttsInput.parse(req.body || {});
    const script = await prisma.videoScript.findUnique({ where: { id: routeParam(req.params.id) } });
    if (!script) throw Object.assign(new Error("文案不存在"), { status: 404 });
    const sentences = (script.sentences ?? null) as TtsSentencePlan[] | null;
    if (!sentences || !sentences.length) throw Object.assign(new Error("请先拆句"), { status: 400 });
    const voice = input.voice ?? DEFAULT_TTS_VOICE;

    const results: TtsSentenceResult[] = [];
    const failedSentenceIds: number[] = [];
    const tempDir = await mkdtemp(join(tmpdir(), "video-tts-"));
    try {
        for (const sentence of sentences) {
            try {
                const { mp3 } = await synthesizeTts(sentence.text, voice);
                // 先落盘用 ffprobe 实测时长，失败就不入库（避免产生无时长的旁白文件）
                const tempPath = join(tempDir, `${sentence.sentenceId}.mp3`);
                await writeFile(tempPath, mp3);
                const probe = await probeMedia(tempPath);
                const objectKey = `video/tts/${script.id}/${sentence.sentenceId}.mp3`;
                await putObject(objectKey, mp3, "audio/mpeg");
                const mediaFile = await prisma.mediaFile.create({
                    data: {
                        ownerId: script.createdById,
                        createdById: script.createdById,
                        objectKey,
                        fileName: `${script.id}_${sentence.sentenceId}.mp3`,
                        mimeType: "audio/mpeg",
                        bytes: BigInt(mp3.length),
                        origin: "video",
                        visibility: "private",
                    },
                });
                results.push({ sentenceId: sentence.sentenceId, mediaId: mediaFile.id, duration: probe.duration });
            } catch (error) {
                failedSentenceIds.push(sentence.sentenceId);
                results.push({ sentenceId: sentence.sentenceId, mediaId: null, duration: null });
                console.error("[video-tts] 句子旁白生成失败", script.id, sentence.sentenceId, error);
            }
        }
    } finally {
        await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }

    const updated = await prisma.videoScript.update({
        where: { id: script.id },
        data: { sentences: json(applyTtsResults(sentences, results)) },
    });
    res.json({ script: scriptDto(updated), failedSentenceIds });
});

export default router;

import express from "express";
import request from "supertest";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    requireReadyUser: vi.fn(),
    scriptFindUnique: vi.fn(),
    scriptUpdate: vi.fn(),
    mediaCreate: vi.fn(),
    putObject: vi.fn(),
    probeMedia: vi.fn(),
    setMetadata: vi.fn(),
    toStream: vi.fn(),
    close: vi.fn(),
}));

vi.mock("../access.js", () => ({ requireReadyUser: mocks.requireReadyUser }));
vi.mock("../db.js", () => ({
    prisma: {
        videoScript: { findUnique: mocks.scriptFindUnique, update: mocks.scriptUpdate },
        mediaFile: { create: mocks.mediaCreate },
    },
}));
vi.mock("../storage.js", () => ({ putObject: mocks.putObject, removeObject: vi.fn(), getObject: vi.fn(), getPartialObject: vi.fn() }));
vi.mock("./ffmpeg.js", () => ({ probeMedia: mocks.probeMedia, runFfmpeg: vi.fn(), extractMidFrame: vi.fn(), locateFfmpeg: vi.fn(), locateFfprobe: vi.fn() }));
vi.mock("msedge-tts", () => ({
    MsEdgeTTS: class MockMsEdgeTTS {
        setMetadata(...args: unknown[]) { return mocks.setMetadata(...args); }
        toStream(...args: unknown[]) { return mocks.toStream(...args); }
        close() { mocks.close(); }
    },
    OUTPUT_FORMAT: { AUDIO_24KHZ_48KBITRATE_MONO_MP3: "audio-24khz-48kbitrate-mono-mp3" },
}));

import videoTtsRouter from "./routes-tts.js";

const user = { id: "11111111-1111-4111-8111-111111111111", username: "tester", role: "member", mustChangePassword: false };
const scriptId = "22222222-2222-4222-8222-222222222222";
const creatorId = "44444444-4444-4444-8444-444444444444";
const MP3 = Buffer.from("fake-mp3-bytes");

const sentences = [
    { sentenceId: 1, text: "这款无钢圈文胸久穿不勒", needCategory: "文胸", durationHint: 3, visualNote: "上身贴合" },
    { sentenceId: 2, text: "穿上就像没穿一样", needCategory: "通用", durationHint: 3, visualNote: "穿衣动作" },
];

function scriptRow(overrides: Record<string, unknown> = {}) {
    return { id: scriptId, title: "无钢圈文胸", sku: "A123", rawText: "这款无钢圈文胸，久穿不勒。", sentences: null, status: "split", createdById: creatorId, createdAt: new Date(), ...overrides };
}

function app() {
    const value = express();
    value.use(express.json());
    value.use((req, _res, next) => { (req as unknown as { user: typeof user }).user = user; next(); });
    value.use("/api/video", videoTtsRouter);
    value.use((error: { status?: number; name?: string; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error.status || (error.name === "ZodError" ? 400 : 500)).json({ error: error.message }));
    return value;
}

describe("video tts routes", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.requireReadyUser.mockImplementation((_req: express.Request, _res: express.Response, next: express.NextFunction) => next());
        mocks.scriptFindUnique.mockResolvedValue(scriptRow({ sentences: sentences.map((entry) => ({ ...entry })) }));
        mocks.scriptUpdate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ ...scriptRow(), ...data }));
        mocks.mediaCreate.mockImplementation(async ({ data }: { data: { fileName: string } }) => ({ id: `media-${data.fileName}`, ...data }));
        mocks.putObject.mockResolvedValue(undefined);
        mocks.probeMedia.mockResolvedValue({ duration: 2.5, width: null, height: null });
        mocks.setMetadata.mockResolvedValue(undefined);
        mocks.toStream.mockImplementation(() => ({ audioStream: Readable.from([MP3]) }));
        mocks.close.mockReset();
    });

    it("requires a logged-in ready user", async () => {
        mocks.requireReadyUser.mockImplementationOnce((_req: express.Request, _res: express.Response, next: express.NextFunction) => next(Object.assign(new Error("请先登录"), { status: 401 })));
        const response = await request(app()).post(`/api/video/scripts/${scriptId}/tts`).send({});
        expect(response.status).toBe(401);
        expect(mocks.scriptFindUnique).not.toHaveBeenCalled();
    });

    it("returns 404 when the script does not exist", async () => {
        mocks.scriptFindUnique.mockResolvedValue(null);
        const response = await request(app()).post(`/api/video/scripts/${scriptId}/tts`).send({});
        expect(response.status).toBe(404);
        expect(response.body.error).toContain("文案不存在");
        expect(mocks.mediaCreate).not.toHaveBeenCalled();
    });

    it("returns 400 when the script has not been split yet", async () => {
        mocks.scriptFindUnique.mockResolvedValue(scriptRow({ sentences: null }));
        const nullResponse = await request(app()).post(`/api/video/scripts/${scriptId}/tts`).send({});
        expect(nullResponse.status).toBe(400);
        expect(nullResponse.body.error).toContain("请先拆句");
        mocks.scriptFindUnique.mockResolvedValue(scriptRow({ sentences: [] }));
        const emptyResponse = await request(app()).post(`/api/video/scripts/${scriptId}/tts`).send({});
        expect(emptyResponse.status).toBe(400);
        expect(emptyResponse.body.error).toContain("请先拆句");
        expect(mocks.setMetadata).not.toHaveBeenCalled();
    });

    it("synthesizes every sentence and writes tts fields back into script.sentences", async () => {
        const response = await request(app()).post(`/api/video/scripts/${scriptId}/tts`).send({});
        expect(response.status).toBe(200);
        expect(response.body.failedSentenceIds).toEqual([]);
        expect(response.body.script).toEqual(expect.objectContaining({ id: scriptId, title: "无钢圈文胸", sku: "A123", status: "split" }));
        expect(response.body.script.sentences).toEqual([
            expect.objectContaining({ sentenceId: 1, ttsMediaId: `media-${scriptId}_1.mp3`, ttsDuration: 2.5, durationHint: 2.5, textDurationHint: 3 }),
            expect.objectContaining({ sentenceId: 2, ttsMediaId: `media-${scriptId}_2.mp3`, ttsDuration: 2.5, durationHint: 2.5, textDurationHint: 3 }),
        ]);
        expect(mocks.setMetadata).toHaveBeenCalledTimes(2);
        expect(mocks.setMetadata).toHaveBeenNthCalledWith(1, "zh-CN-XiaoxiaoNeural", "audio-24khz-48kbitrate-mono-mp3");
        expect(mocks.probeMedia).toHaveBeenCalledTimes(2);
        expect(mocks.probeMedia.mock.calls[0][0].replace(/\\/g, "/")).toMatch(/\/1\.mp3$/);
        expect(mocks.putObject).toHaveBeenCalledTimes(2);
        expect(mocks.putObject).toHaveBeenNthCalledWith(1, `video/tts/${scriptId}/1.mp3`, MP3, "audio/mpeg");
        expect(mocks.mediaCreate).toHaveBeenCalledTimes(2);
        expect(mocks.mediaCreate).toHaveBeenNthCalledWith(1, {
            data: {
                ownerId: creatorId,
                createdById: creatorId,
                objectKey: `video/tts/${scriptId}/1.mp3`,
                fileName: `${scriptId}_1.mp3`,
                mimeType: "audio/mpeg",
                bytes: BigInt(MP3.length),
                origin: "video",
                visibility: "private",
            },
        });
        expect(mocks.scriptUpdate).toHaveBeenCalledWith({
            where: { id: scriptId },
            data: { sentences: [
                expect.objectContaining({ sentenceId: 1, ttsMediaId: `media-${scriptId}_1.mp3` }),
                expect.objectContaining({ sentenceId: 2, ttsMediaId: `media-${scriptId}_2.mp3` }),
            ] },
        });
    });

    it("passes a custom voice from the request body", async () => {
        const response = await request(app()).post(`/api/video/scripts/${scriptId}/tts`).send({ voice: "zh-CN-YunxiNeural" });
        expect(response.status).toBe(200);
        expect(mocks.setMetadata).toHaveBeenCalledWith("zh-CN-YunxiNeural", "audio-24khz-48kbitrate-mono-mp3");
    });

    it("degrades failed sentences without failing the whole request", async () => {
        mocks.setMetadata.mockRejectedValue(new Error("rate limited"));
        const response = await request(app()).post(`/api/video/scripts/${scriptId}/tts`).send({});
        expect(response.status).toBe(200);
        expect(response.body.failedSentenceIds).toEqual([1, 2]);
        expect(response.body.script.sentences).toEqual([
            expect.objectContaining({ sentenceId: 1, ttsMediaId: null, ttsDuration: null, durationHint: 3 }),
            expect.objectContaining({ sentenceId: 2, ttsMediaId: null, ttsDuration: null, durationHint: 3 }),
        ]);
        expect(mocks.mediaCreate).not.toHaveBeenCalled();
        expect(mocks.putObject).not.toHaveBeenCalled();
        // 句级失败仍会重试 2 次（每句 3 次尝试）
        expect(mocks.setMetadata.mock.calls.length).toBeGreaterThanOrEqual(2);
        // 降级结果仍然回写 sentences
        expect(mocks.scriptUpdate).toHaveBeenCalledWith({
            where: { id: scriptId },
            data: { sentences: [
                expect.objectContaining({ sentenceId: 1, ttsMediaId: null }),
                expect.objectContaining({ sentenceId: 2, ttsMediaId: null }),
            ] },
        });
    });

    it("keeps successful sentences when only some fail", async () => {
        let call = 0;
        mocks.setMetadata.mockImplementation(() => {
            call += 1;
            if (call === 1) return Promise.resolve(undefined);
            // 第二句连续失败（重试 2 次仍失败）
            return Promise.reject(new Error("boom"));
        });
        const response = await request(app()).post(`/api/video/scripts/${scriptId}/tts`).send({});
        expect(response.status).toBe(200);
        expect(response.body.failedSentenceIds).toEqual([2]);
        expect(response.body.script.sentences[0]).toEqual(expect.objectContaining({ ttsMediaId: `media-${scriptId}_1.mp3`, durationHint: 2.5 }));
        expect(response.body.script.sentences[1]).toEqual(expect.objectContaining({ ttsMediaId: null, durationHint: 3 }));
    });

    it("rejects an invalid voice payload with 400", async () => {
        const response = await request(app()).post(`/api/video/scripts/${scriptId}/tts`).send({ voice: "" });
        expect(response.status).toBe(400);
        expect(response.body.error).toContain("音色名不能为空");
        expect(mocks.setMetadata).not.toHaveBeenCalled();
    });
});

import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    setMetadata: vi.fn(),
    toStream: vi.fn(),
    close: vi.fn(),
    instances: [] as number[],
}));

// msedge-tts 整体 mock：类方法全部转发到 mocks，便于按用例控制成功/失败/音频内容
vi.mock("msedge-tts", () => ({
    MsEdgeTTS: class MockMsEdgeTTS {
        constructor() {
            mocks.instances.push(mocks.instances.length + 1);
        }
        setMetadata(...args: unknown[]) {
            return mocks.setMetadata(...args);
        }
        toStream(...args: unknown[]) {
            return mocks.toStream(...args);
        }
        close() {
            mocks.close();
        }
    },
    OUTPUT_FORMAT: { AUDIO_24KHZ_48KBITRATE_MONO_MP3: "audio-24khz-48kbitrate-mono-mp3" },
}));

import { applyTtsResults, DEFAULT_TTS_VOICE, synthesizeTts, type TtsSentencePlan } from "./tts.js";

const MP3 = Buffer.from("fake-mp3-bytes");

function audioStreamOf(payload: Buffer[]): Readable {
    return Readable.from(payload);
}

function neverEndingStream(): Readable {
    return new Readable({ read() { /* 永不推送也永不结束 */ } });
}

function sentence(overrides: Partial<TtsSentencePlan> = {}): TtsSentencePlan {
    return {
        sentenceId: 1,
        text: "这款无钢圈文胸久穿不勒",
        needCategory: "文胸",
        durationHint: 3,
        visualNote: "",
        ...overrides,
    };
}

describe("synthesizeTts", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.instances.length = 0;
        mocks.setMetadata.mockResolvedValue(undefined);
        mocks.toStream.mockReturnValue({ audioStream: audioStreamOf([MP3]) });
    });

    it("returns the collected mp3 buffer with the default voice", async () => {
        const result = await synthesizeTts("你好世界");
        expect(result.mp3.equals(MP3)).toBe(true);
        expect(mocks.setMetadata).toHaveBeenCalledWith(DEFAULT_TTS_VOICE, "audio-24khz-48kbitrate-mono-mp3");
        expect(mocks.toStream).toHaveBeenCalledWith("你好世界");
        expect(mocks.instances).toHaveLength(1);
        expect(mocks.close).toHaveBeenCalledTimes(1);
    });

    it("passes a custom voice through to setMetadata", async () => {
        await synthesizeTts("你好", "zh-CN-YunxiNeural");
        expect(mocks.setMetadata).toHaveBeenCalledWith("zh-CN-YunxiNeural", "audio-24khz-48kbitrate-mono-mp3");
    });

    it("exposes zh-CN-XiaoxiaoNeural as the default voice constant", () => {
        expect(DEFAULT_TTS_VOICE).toBe("zh-CN-XiaoxiaoNeural");
    });

    it("retries twice and succeeds on the third attempt", async () => {
        mocks.setMetadata
            .mockRejectedValueOnce(new Error("connection reset"))
            .mockRejectedValueOnce(new Error("timeout on wire"))
            .mockResolvedValue(undefined);
        const result = await synthesizeTts("重试成功");
        expect(result.mp3.equals(MP3)).toBe(true);
        expect(mocks.setMetadata).toHaveBeenCalledTimes(3);
        expect(mocks.instances).toHaveLength(3);
        expect(mocks.close).toHaveBeenCalledTimes(3);
    });

    it("throws a Chinese error after exhausting retries", async () => {
        mocks.setMetadata.mockRejectedValue(new Error("boom"));
        await expect(synthesizeTts("全部失败")).rejects.toThrow("语音合成失败（已重试 2 次）：boom");
        expect(mocks.setMetadata).toHaveBeenCalledTimes(3);
    });

    it("treats an empty audio stream as a failure (and retries)", async () => {
        mocks.toStream.mockReturnValue({ audioStream: audioStreamOf([]) });
        await expect(synthesizeTts("空音频", "zh-CN-XiaoxiaoNeural", { retries: 0 })).rejects.toThrow("语音服务未返回音频数据");
    });

    it("aborts with a Chinese timeout error when the stream never ends", async () => {
        mocks.toStream.mockReturnValue({ audioStream: neverEndingStream() });
        await expect(synthesizeTts("卡死的流", "zh-CN-XiaoxiaoNeural", { timeoutMs: 20, retries: 0 })).rejects.toThrow("语音合成超时");
        expect(mocks.close).toHaveBeenCalledTimes(1);
    });

    it("rejects empty or oversized text without touching the tts client", async () => {
        await expect(synthesizeTts("   ")).rejects.toThrow("合成文本不能为空");
        await expect(synthesizeTts("字".repeat(501))).rejects.toThrow("合成文本过长");
        expect(mocks.setMetadata).not.toHaveBeenCalled();
    });
});

describe("applyTtsResults", () => {
    it("rewrites durationHint to the measured duration and backs up the original estimate into textDurationHint", () => {
        const updated = applyTtsResults([sentence({ durationHint: 3 })], [{ sentenceId: 1, mediaId: "media-1", duration: 2.876 }]);
        expect(updated[0]).toEqual(expect.objectContaining({
            durationHint: 2.88,
            textDurationHint: 3,
            ttsMediaId: "media-1",
            ttsDuration: 2.876,
        }));
    });

    it("keeps the original textDurationHint across repeated generations", () => {
        const once = applyTtsResults([sentence({ durationHint: 3 })], [{ sentenceId: 1, mediaId: "media-1", duration: 2.8 }]);
        const twice = applyTtsResults(once, [{ sentenceId: 1, mediaId: "media-2", duration: 4.21 }]);
        expect(twice[0]).toEqual(expect.objectContaining({
            durationHint: 4.21,
            textDurationHint: 3,
            ttsMediaId: "media-2",
            ttsDuration: 4.21,
        }));
    });

    it("degrades a failed sentence back to the char-count estimate", () => {
        const updated = applyTtsResults([sentence({ durationHint: 3.5 })], [{ sentenceId: 1, mediaId: null, duration: null }]);
        expect(updated[0]).toEqual(expect.objectContaining({
            durationHint: 3.5,
            ttsMediaId: null,
            ttsDuration: null,
        }));
        expect(updated[0].textDurationHint).toBeUndefined();
    });

    it("restores durationHint from textDurationHint when a previously voiced sentence fails on regeneration", () => {
        const voiced = applyTtsResults([sentence({ durationHint: 3 })], [{ sentenceId: 1, mediaId: "media-1", duration: 2.8 }]);
        const degraded = applyTtsResults(voiced, [{ sentenceId: 1, mediaId: null, duration: null }]);
        expect(degraded[0]).toEqual(expect.objectContaining({
            durationHint: 3,
            textDurationHint: 3,
            ttsMediaId: null,
            ttsDuration: null,
        }));
    });

    it("updates each sentence independently and leaves sentences without a result untouched", () => {
        const updated = applyTtsResults([
            sentence({ sentenceId: 1, durationHint: 2 }),
            sentence({ sentenceId: 2, durationHint: 4 }),
        ], [
            { sentenceId: 1, mediaId: "media-1", duration: 1.9 },
            { sentenceId: 2, mediaId: null, duration: null },
        ]);
        expect(updated[0]).toEqual(expect.objectContaining({ ttsMediaId: "media-1", durationHint: 1.9, textDurationHint: 2 }));
        expect(updated[1]).toEqual(expect.objectContaining({ ttsMediaId: null, ttsDuration: null, durationHint: 4 }));
    });
});

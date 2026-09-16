import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({ prisma: {} }));
vi.mock("../storage.js", () => ({ putObject: vi.fn(), removeObject: vi.fn(), getObject: vi.fn(), getPartialObject: vi.fn() }));
vi.mock("./ffmpeg.js", () => ({ probeMedia: vi.fn(), extractMidFrame: vi.fn(), runFfmpeg: vi.fn(), locateFfmpeg: vi.fn(), locateFfprobe: vi.fn() }));

import {
    buildAudioPlan,
    buildBurnArgs,
    buildExportFileName,
    buildMixAudioArgs,
    concatListLine,
    filterRenderableItems,
    formatSkipSummary,
    listBgmAssets,
    parseExportParams,
    parseSentenceTtsMap,
    parseTimelineItems,
    sanitizeFileNamePart,
    segmentProgress,
    shouldWriteProgress,
    subtitleProgress,
} from "./export.js";
import type { TimelineItem } from "./ass.js";

const item = (overrides: Partial<TimelineItem>): TimelineItem => ({
    sentenceId: 1,
    subtitle: "字幕",
    duration: 1,
    segments: [{ materialId: "material-1", inPoint: 0, outPoint: 1 }],
    ...overrides,
});

describe("concatListLine", () => {
    it("wraps an absolute path in single quotes", () => {
        expect(concatListLine("/tmp/video-export-1/seg_1.mp4")).toBe("file '/tmp/video-export-1/seg_1.mp4'");
    });

    it("normalizes windows backslashes to forward slashes", () => {
        expect(concatListLine("C:\\Users\\1\\AppData\\Local\\Temp\\video-export-1\\seg_1.mp4")).toBe("file 'C:/Users/1/AppData/Local/Temp/video-export-1/seg_1.mp4'");
    });

    it("escapes single quotes in the path the concat-demuxer way", () => {
        expect(concatListLine("C:\\tmp\\it's fine\\seg 1.mp4")).toBe("file 'C:/tmp/it'\\''s fine/seg 1.mp4'");
    });
});

describe("buildBurnArgs", () => {
    it("uses a relative ass filename so the filter arg never contains a windows drive-letter colon", () => {
        const args = buildBurnArgs("subs.ass", "C:/tmp/x/body.mp4", "C:/tmp/x/out.mp4");
        const assArg = args[args.indexOf("-vf") + 1];
        expect(assArg).toBe("ass=subs.ass");
        expect(assArg).not.toMatch(/:/);
    });

    it("keeps progress reporting on stdout for the out_time_ms parser", () => {
        const args = buildBurnArgs("subs.ass", "body.mp4", "out.mp4");
        expect(args).toContain("-progress");
        expect(args[args.indexOf("-progress") + 1]).toBe("pipe:1");
    });
});

describe("segmentProgress", () => {
    it("maps finished segments linearly onto 0-80", () => {
        expect(segmentProgress(0, 10)).toBe(0);
        expect(segmentProgress(5, 10)).toBe(40);
        expect(segmentProgress(10, 10)).toBe(80);
    });

    it("returns 80 when there is nothing to process", () => {
        expect(segmentProgress(0, 0)).toBe(80);
    });

    it("clamps overshoot", () => {
        expect(segmentProgress(12, 10)).toBe(80);
    });
});

describe("subtitleProgress", () => {
    it("maps out_time_ms (microseconds!) of the burn step onto 80-100", () => {
        expect(subtitleProgress(0, 10)).toBe(80);
        expect(subtitleProgress(5_000_000, 10)).toBe(90); // 5 秒 / 10 秒
        expect(subtitleProgress(10_000_000, 10)).toBe(100);
    });

    it("clamps beyond the total duration and handles invalid input", () => {
        expect(subtitleProgress(12_000_000, 10)).toBe(100);
        expect(subtitleProgress(-1, 10)).toBe(80);
        expect(subtitleProgress(Number.NaN, 10)).toBe(80);
        expect(subtitleProgress(5_000_000, 0)).toBe(80);
    });
});

describe("shouldWriteProgress", () => {
    it("always allows the first write", () => {
        expect(shouldWriteProgress(0, -1, 0)).toBe(true);
    });

    it("throttles small changes within 1s", () => {
        expect(shouldWriteProgress(1, 0, 100)).toBe(false);
    });

    it("writes when the value moved by at least 2 points", () => {
        expect(shouldWriteProgress(2, 0, 100)).toBe(true);
        expect(shouldWriteProgress(99, 97, 500)).toBe(true);
    });

    it("writes when 1s elapsed even for a small change", () => {
        expect(shouldWriteProgress(1, 0, 1500)).toBe(true);
    });

    it("skips unchanged values regardless of elapsed time", () => {
        expect(shouldWriteProgress(5, 5, 5000)).toBe(false);
    });
});

describe("filterRenderableItems", () => {
    it("keeps sentences whose materials are all available", () => {
        const { renderable, skips } = filterRenderableItems([
            item({ sentenceId: 1, segments: [{ materialId: "m1", inPoint: 0, outPoint: 2 }, { materialId: "m2", inPoint: 0, outPoint: 2 }] }),
        ], new Set(["m1", "m2"]));
        expect(renderable).toHaveLength(1);
        expect(skips).toEqual([]);
    });

    it("skips gap sentences without segments and sentences with unavailable materials", () => {
        const { renderable, skips } = filterRenderableItems([
            item({ sentenceId: 1, subtitle: "ok", duration: 2 }),
            item({ sentenceId: 2, subtitle: "缺口", duration: 3, segments: [] }),
            item({ sentenceId: 3, subtitle: "素材没了", duration: 4, segments: [{ materialId: "ghost", inPoint: 0, outPoint: 2 }] }),
        ], new Set(["material-1"]));
        expect(renderable.map((entry) => entry.sentenceId)).toEqual([1]);
        expect(skips).toHaveLength(2);
        expect(skips[0]).toEqual({ sentenceId: 2, reason: expect.stringContaining("缺口") });
        expect(skips[1]).toEqual({ sentenceId: 3, reason: expect.stringContaining("ghost") });
    });

    it("skips a whole sentence when only one of its segments is unavailable (keeps subtitle in sync)", () => {
        const { renderable, skips } = filterRenderableItems([
            item({ sentenceId: 7, segments: [{ materialId: "m1", inPoint: 0, outPoint: 2 }, { materialId: "ghost", inPoint: 0, outPoint: 2 }] }),
        ], new Set(["m1"]));
        expect(renderable).toEqual([]);
        expect(skips).toEqual([{ sentenceId: 7, reason: expect.stringContaining("素材不可用") }]);
    });
});

describe("formatSkipSummary", () => {
    it("summarizes skipped sentence ids", () => {
        expect(formatSkipSummary([
            { sentenceId: 2, reason: "缺口句：没有画面段落" },
            { sentenceId: 5, reason: "素材不可用" },
        ])).toBe("跳过 2 句：第2句、第5句");
    });

    it("reports nothing skipped for an empty list", () => {
        expect(formatSkipSummary([])).toBe("没有跳过的句子");
    });
});

describe("parseTimelineItems", () => {
    it("parses well-formed items and drops malformed segments", () => {
        const items = parseTimelineItems([
            { sentenceId: 1, subtitle: "第一句", duration: 4.5, segments: [{ materialId: "m1", inPoint: 0, outPoint: 4.5 }, { garbage: true }] },
            { sentenceId: 2, subtitle: "第二句", duration: 2, segments: [{ materialId: "m2", inPoint: 1, outPoint: 3 }] },
        ]);
        expect(items).toHaveLength(2);
        expect(items[0].segments).toEqual([{ materialId: "m1", inPoint: 0, outPoint: 4.5 }]);
        expect(items[1].segments).toEqual([{ materialId: "m2", inPoint: 1, outPoint: 3 }]);
    });

    it("drops entries with invalid ids or durations", () => {
        const items = parseTimelineItems([
            { sentenceId: "x", subtitle: "坏句子", duration: 1, segments: [] },
            { sentenceId: 3, subtitle: "负时长", duration: -2, segments: [{ materialId: "m1", inPoint: 0, outPoint: 1 }] },
            null,
            "junk",
        ]);
        expect(items).toEqual([]);
    });

    it("returns an empty list for non-array payloads", () => {
        expect(parseTimelineItems(null)).toEqual([]);
        expect(parseTimelineItems({})).toEqual([]);
        expect(parseTimelineItems("nope")).toEqual([]);
    });
});

describe("buildExportFileName", () => {
    it("composes sku, sanitized title and yyyyMMdd_HHmm stamp", () => {
        const now = new Date(2026, 8, 15, 14, 5); // 2026-09-15 14:05 本地时间
        expect(buildExportFileName("A123", "无钢圈文胸主推款", now)).toBe("A123_无钢圈文胸主推款_20260915_1405.mp4");
    });

    it("strips characters that are illegal in windows file names", () => {
        const now = new Date(2026, 0, 2, 9, 8);
        expect(sanitizeFileNamePart('测试<标题>?"|*:')).toBe("测试 标题");
        expect(buildExportFileName("A/B", "标题", now)).toBe("A B_标题_20260102_0908.mp4");
    });

    it("falls back when sku or title is empty after sanitizing", () => {
        const now = new Date(2026, 8, 15, 14, 5);
        expect(buildExportFileName("", "  ", now)).toBe("未命名货号_成片_20260915_1405.mp4");
    });
});

describe("parseExportParams", () => {
    it("applies the P2 defaults for a missing or malformed payload", () => {
        for (const raw of [null, undefined, "junk", 42, [], {}]) {
            expect(parseExportParams(raw)).toEqual({ resolution: "1080x1920", burnSubtitle: true, subtitleStyle: "minimal", bgm: null, bgmVolume: 0.15 });
        }
    });

    it("keeps valid overrides", () => {
        expect(parseExportParams({ burnSubtitle: false, subtitleStyle: "bar", bgm: "轻快日常", bgmVolume: 0.3 })).toEqual({
            resolution: "1080x1920",
            burnSubtitle: false,
            subtitleStyle: "bar",
            bgm: "轻快日常",
            bgmVolume: 0.3,
        });
    });

    it("falls back for invalid field types and clamps the bgm volume", () => {
        expect(parseExportParams({ burnSubtitle: "no", subtitleStyle: "fancy", bgm: "  ", bgmVolume: 1.7 })).toEqual({
            resolution: "1080x1920",
            burnSubtitle: true,
            subtitleStyle: "minimal",
            bgm: null,
            bgmVolume: 1,
        });
        expect(parseExportParams({ bgmVolume: -1 }).bgmVolume).toBe(0);
    });
});

describe("listBgmAssets", () => {
    it("lists mp3 files as id/file-name pairs, sorted and case-insensitive on the extension", () => {
        const dir = mkdtempSync(join(tmpdir(), "bgm-assets-"));
        try {
            writeFileSync(join(dir, "轻快日常.mp3"), "x");
            writeFileSync(join(dir, "Upbeat.MP3"), "x");
            writeFileSync(join(dir, "README.md"), "x");
            writeFileSync(join(dir, "notes.txt"), "x");
            expect(listBgmAssets(dir)).toEqual([
                { id: "Upbeat", fileName: "Upbeat.MP3" },
                { id: "轻快日常", fileName: "轻快日常.mp3" },
            ]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("returns an empty list when the directory is missing or unreadable", () => {
        expect(listBgmAssets(join(tmpdir(), "definitely-missing-bgm-dir"))).toEqual([]);
    });
});

describe("parseSentenceTtsMap", () => {
    it("maps sentence ids to tts media ids and skips invalid entries", () => {
        const map = parseSentenceTtsMap([
            { sentenceId: 1, text: "第一句", ttsMediaId: "media-1" },
            { sentenceId: 2, text: "没有旁白" },
            { sentenceId: 3, text: "空旁白", ttsMediaId: null },
            { sentenceId: "x", ttsMediaId: "media-x" },
            null,
            "junk",
        ]);
        expect(map.size).toBe(1);
        expect(map.get(1)).toBe("media-1");
    });

    it("returns an empty map for non-array payloads", () => {
        expect(parseSentenceTtsMap(null).size).toBe(0);
        expect(parseSentenceTtsMap({}).size).toBe(0);
    });
});

describe("buildAudioPlan", () => {
    it("accumulates start times from previous kept item durations in whole milliseconds", () => {
        const plan = buildAudioPlan([
            item({ sentenceId: 1, duration: 4.5 }),
            item({ sentenceId: 2, duration: 3.2 }),
            item({ sentenceId: 3, duration: 2.001 }),
        ], new Map([[2, "media-2"]]));
        expect(plan).toEqual([
            { sentenceId: 1, startMs: 0, durationMs: 4500, mediaId: null },
            { sentenceId: 2, startMs: 4500, durationMs: 3200, mediaId: "media-2" },
            { sentenceId: 3, startMs: 7700, durationMs: 2001, mediaId: null },
        ]);
    });

    it("lets silent sentences occupy the timeline while voiced ones get their media id", () => {
        const plan = buildAudioPlan([
            item({ sentenceId: 1, duration: 2 }),
            item({ sentenceId: 2, duration: 3 }),
        ], new Map([[1, "media-1"], [2, "media-2"], [9, "media-ghost"]]));
        expect(plan.map((entry) => entry.mediaId)).toEqual(["media-1", "media-2"]);
        expect(plan[1].startMs).toBe(2000);
    });

    it("clamps invalid durations to zero", () => {
        const plan = buildAudioPlan([
            item({ sentenceId: 1, duration: Number.NaN }),
            item({ sentenceId: 2, duration: 1 }),
        ], new Map());
        expect(plan[0].durationMs).toBe(0);
        expect(plan[1].startMs).toBe(0);
    });
});

describe("buildMixAudioArgs", () => {
    const voices = [
        { startMs: 0, durationMs: 4500, filePath: "C:/tmp/x/tts_1.mp3" },
        { startMs: 4500, durationMs: 3200, filePath: "C:/tmp/x/tts_2.mp3" },
    ];

    it("delays, trims and pads each voice then mixes without normalization", () => {
        const args = buildMixAudioArgs({ bodyPath: "C:/tmp/x/burned.mp4", outPath: "C:/tmp/x/out.mp4", voices, bgmPath: null, bgmVolume: 0.15, totalSeconds: 7.7 });
        expect(args).toEqual([
            "-y",
            "-i", "C:/tmp/x/burned.mp4",
            "-i", "C:/tmp/x/tts_1.mp3",
            "-i", "C:/tmp/x/tts_2.mp3",
            "-filter_complex", [
                "[1:a]adelay=0|0,atrim=0:4.5,apad[a0]",
                "[2:a]adelay=4500|4500,atrim=0:7.7,apad[a1]",
                "[a0][a1]amix=inputs=2:normalize=0[aout]",
            ].join(";"),
            "-map", "0:v",
            "-map", "[aout]",
            "-c:v", "copy",
            "-c:a", "aac",
            "-shortest",
            "C:/tmp/x/out.mp4",
        ]);
    });

    it("adds a bgm lane with a constant volume trimmed to the total duration", () => {
        const args = buildMixAudioArgs({ bodyPath: "body.mp4", outPath: "out.mp4", voices: voices.slice(0, 1), bgmPath: "C:/assets/bgm/轻快日常.mp3", bgmVolume: 0.15, totalSeconds: 4.5 });
        const filter = args[args.indexOf("-filter_complex") + 1];
        expect(filter).toContain("[2:a]volume=0.15,atrim=0:4.5[abgm]");
        expect(filter).toContain("[a0][abgm]amix=inputs=2:normalize=0[aout]");
        expect(args).toEqual(expect.arrayContaining(["-i", "C:/assets/bgm/轻快日常.mp3"]));
    });

    it("mixes a bgm-only track when there are no voices", () => {
        const args = buildMixAudioArgs({ bodyPath: "body.mp4", outPath: "out.mp4", voices: [], bgmPath: "bgm.mp3", bgmVolume: 0.3, totalSeconds: 10 });
        const filter = args[args.indexOf("-filter_complex") + 1];
        expect(filter).toContain("[1:a]volume=0.3,atrim=0:10[abgm]");
        expect(filter).toContain("[abgm]amix=inputs=1:normalize=0[aout]");
    });

    it("clamps an invalid bgm volume back into 0-1", () => {
        const args = buildMixAudioArgs({ bodyPath: "body.mp4", outPath: "out.mp4", voices: [], bgmPath: "bgm.mp3", bgmVolume: Number.NaN, totalSeconds: 5 });
        const filter = args[args.indexOf("-filter_complex") + 1];
        expect(filter).toContain("volume=0.15");
    });
});

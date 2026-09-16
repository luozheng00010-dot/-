import { describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({ prisma: {} }));
vi.mock("../storage.js", () => ({ putObject: vi.fn(), removeObject: vi.fn(), getObject: vi.fn(), getPartialObject: vi.fn() }));
vi.mock("./ffmpeg.js", () => ({ probeMedia: vi.fn(), extractMidFrame: vi.fn(), runFfmpeg: vi.fn(), locateFfmpeg: vi.fn(), locateFfprobe: vi.fn() }));
vi.mock("./llm.js", () => ({ visionJson: vi.fn(), chatJson: vi.fn(), resolveVideoModel: vi.fn() }));
vi.mock("sharp", () => ({ default: vi.fn() }));

import { batchFinalStatus, buildTagPrompt, mergeTagDescription } from "./ingest.js";

describe("mergeTagDescription", () => {
    it("appends the AI suspicion when the predicted category differs from the human one", () => {
        expect(mergeTagDescription("模特整理肩带", "内裤", "文胸")).toBe("模特整理肩带（AI 疑似：内裤）");
    });

    it("keeps the description untouched when the prediction matches the human category", () => {
        expect(mergeTagDescription("无钢圈细节特写", "文胸", "文胸")).toBe("无钢圈细节特写");
    });

    it("ignores surrounding whitespace when comparing categories", () => {
        expect(mergeTagDescription("平铺摆放", " 文胸 ", "文胸")).toBe("平铺摆放");
    });

    it("does not append anything for an empty prediction", () => {
        expect(mergeTagDescription("场景氛围", "", "通用")).toBe("场景氛围");
    });
});

describe("buildTagPrompt", () => {
    it("injects the dynamic category list joined with slashes", () => {
        const prompt = buildTagPrompt(["文胸", "内裤", "通用"]);
        expect(prompt).toContain("从给定清单中选：文胸/内裤/通用");
        expect(prompt).toContain("文胸/内裤/通用");
    });

    it("falls back to 通用 when the category list is empty", () => {
        expect(buildTagPrompt([])).toContain("从给定清单中选：通用");
    });

    it("contains the JSON output skeleton from the spec", () => {
        const prompt = buildTagPrompt(["文胸"]);
        for (const key of ["category", "shotType", "motion", "productVisible", "description"]) {
            expect(prompt).toContain(`"${key}"`);
        }
        expect(prompt).toContain("只输出 JSON");
        expect(prompt).toContain("特写|近景|中景|全景");
        expect(prompt).toContain("旋转|手持|摆放|穿戴|平铺|使用演示|其他");
    });
});

describe("batchFinalStatus", () => {
    it("stays processing until every material reaches a terminal state", () => {
        expect(batchFinalStatus(0, 0, 10)).toBe("processing");
        expect(batchFinalStatus(5, 4, 10)).toBe("processing");
        expect(batchFinalStatus(0, 0, 0)).toBe("processing");
    });

    it("settles as done when everything succeeded", () => {
        expect(batchFinalStatus(10, 0, 10)).toBe("done");
        expect(batchFinalStatus(1, 0, 1)).toBe("done");
    });

    it("settles as partial when some materials failed", () => {
        expect(batchFinalStatus(9, 1, 10)).toBe("partial");
        expect(batchFinalStatus(1, 9, 10)).toBe("partial");
    });

    it("settles as failed when every material failed", () => {
        expect(batchFinalStatus(0, 10, 10)).toBe("failed");
    });
});

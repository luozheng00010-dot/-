import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ materialFindMany: vi.fn(), chatJson: vi.fn() }));

vi.mock("../db.js", () => ({ prisma: { videoMaterial: { findMany: mocks.materialFindMany } } }));
vi.mock("./llm.js", () => ({
    chatJson: mocks.chatJson,
    VideoLlmError: class VideoLlmError extends Error {
        status: number;
        constructor(message: string, status = 502) { super(message); this.status = status; }
    },
}));

import {
    assembleTimelineItems,
    buildCandidatePools,
    buildGapReport,
    buildSentencePool,
    capCandidatePool,
    clampSegmentsToHint,
    collectSegmentViolations,
    matchTimeline,
    rematchSentence,
    totalSegmentDuration,
    validateMatchItems,
    type CandidateMaterial,
    type Segment,
    type TimelineItem,
} from "./match.js";
import type { SentencePlan } from "./split.js";

const SKU = "A123";

function sentence(overrides: Partial<SentencePlan> = {}): SentencePlan {
    return { sentenceId: 1, text: "这款无钢圈文胸，久穿不勒", needCategory: "文胸", durationHint: 4.5, visualNote: "上身贴合", ...overrides };
}

function material(id: string, overrides: Partial<CandidateMaterial> = {}): CandidateMaterial {
    return { id, sku: SKU, categoryName: "文胸", duration: 3, description: "画面", shotType: "特写", motion: "旋转", useCount: 0, ...overrides };
}

function segment(materialId: string, outPoint: number, overrides: Partial<Segment> = {}): Segment {
    return { materialId, inPoint: 0, outPoint, reason: "贴合", ...overrides };
}

/** DB 行形状（select id/sku/duration/description/shotType/motion/useCount/category.name） */
function dbRow(item: CandidateMaterial) {
    return { ...item, category: { name: item.categoryName } };
}

describe("buildSentencePool（00 §6 三层候选池）", () => {
    const bra = material("bra-1");
    const panty = material("panty-1", { categoryName: "内裤" });
    const general = material("gen-1", { sku: "通用", categoryName: "通用", duration: 3.5 });

    it("puts same-sku same-category materials first and marks substitutes", () => {
        const pool = buildSentencePool(sentence(), [panty, bra], [general]);
        expect(pool.materials.map((item) => item.id)).toEqual(["bra-1", "panty-1"]);
        expect(pool.materials.map((item) => item.substitute)).toEqual([false, true]);
        expect(pool.primaryCount).toBe(1);
    });

    it("falls back to the downgrade layer when the primary layer is empty", () => {
        const pool = buildSentencePool(sentence({ sentenceId: 2, needCategory: "袜子" }), [bra, panty], []);
        expect(pool.primaryCount).toBe(0);
        expect(pool.materials).toHaveLength(2);
        expect(pool.materials.every((item) => item.substitute)).toBe(true);
    });

    it("yields an empty pool when both layers are empty", () => {
        const pool = buildSentencePool(sentence(), [], []);
        expect(pool.materials).toEqual([]);
    });

    it("uses only sku=通用 materials for a 通用 sentence with no downgrade layer", () => {
        const pool = buildSentencePool(sentence({ sentenceId: 3, needCategory: "通用" }), [bra, panty], [general]);
        expect(pool.materials.map((item) => item.id)).toEqual(["gen-1"]);
        expect(pool.materials.every((item) => item.substitute)).toBe(false);
    });
});

describe("capCandidatePool（00 §6 候选清单控制）", () => {
    const braSentence = sentence();

    it("keeps pools of up to 500 untouched", () => {
        const materials = Array.from({ length: 500 }, (_, index) => material(`m-${index}`));
        const pool = capCandidatePool(buildSentencePool(braSentence, materials, []));
        expect(pool.materials).toHaveLength(500);
    });

    it("filters by needCategory first when the pool exceeds 500", () => {
        const primary = Array.from({ length: 300 }, (_, index) => material(`p-${index}`));
        const substitutes = Array.from({ length: 201 }, (_, index) => material(`s-${index}`, { categoryName: "内裤" }));
        const pool = capCandidatePool(buildSentencePool(braSentence, [...substitutes, ...primary], []));
        expect(pool.materials).toHaveLength(300);
        expect(pool.materials.every((item) => item.id.startsWith("p-"))).toBe(true);
        expect(pool.materials.every((item) => !item.substitute)).toBe(true);
    });

    it("truncates to 300 by useCount descending when the category filter is still too large", () => {
        const primary = Array.from({ length: 600 }, (_, index) => material(`p-${index}`, { useCount: index }));
        const pool = capCandidatePool(buildSentencePool(braSentence, primary, []));
        expect(pool.materials).toHaveLength(300);
        expect(pool.materials[0].id).toBe("p-599");
        expect(pool.materials[299].id).toBe("p-300");
    });
});

describe("collectSegmentViolations / validateMatchItems（01 §4.3 服务端校验）", () => {
    const bra = material("bra-1", { duration: 3 });
    const panty = material("panty-1", { categoryName: "内裤", duration: 2 });
    const general = material("gen-1", { sku: "通用", categoryName: "通用" });
    const sentences = [sentence(), sentence({ sentenceId: 2, needCategory: "通用", durationHint: 3 })];
    const pools = buildCandidatePools(sentences, [bra, panty], [general]);

    it("flags a material outside the sentence candidate pool", () => {
        const result = validateMatchItems([{ sentenceId: 1, segments: [{ materialId: "gen-1", inPoint: 0, outPoint: 3, reason: "" }], downgraded: false }], sentences, pools);
        expect(result.errors).toEqual([expect.stringContaining("不在该句候选池内")]);
    });

    it("flags a fabricated materialId as missing", () => {
        const result = validateMatchItems([{ sentenceId: 1, segments: [{ materialId: "ghost", inPoint: 0, outPoint: 1, reason: "" }], downgraded: false }], sentences, pools);
        expect(result.errors[0]).toContain("不存在或已归档");
    });

    it("rejects a non-zero inPoint", () => {
        const result = validateMatchItems([{ sentenceId: 1, segments: [{ materialId: "bra-1", inPoint: 0.5, outPoint: 3, reason: "" }], downgraded: false }], sentences, pools);
        expect(result.errors[0]).toContain("inPoint 必须为 0");
    });

    it("rejects segment lengths outside 0.5s..duration", () => {
        const tooLong = validateMatchItems([{ sentenceId: 1, segments: [{ materialId: "bra-1", inPoint: 0, outPoint: 3.5, reason: "" }], downgraded: false }], sentences, pools);
        expect(tooLong.errors[0]).toContain("段时长必须在 0.5 秒到素材时长（3 秒）之间");
        const tooShort = validateMatchItems([{ sentenceId: 1, segments: [{ materialId: "bra-1", inPoint: 0, outPoint: 0.3, reason: "" }], downgraded: false }], sentences, pools);
        expect(tooShort.errors[0]).toContain("段时长必须在 0.5 秒到素材时长（3 秒）之间");
    });

    it("marks a 通用 sentence using a sku material as illegal", () => {
        const materialsById = new Map([[bra.id, { sku: bra.sku, duration: bra.duration, categoryName: bra.categoryName }]]);
        const violations = collectSegmentViolations("句子 2 第 1 段", "通用", [segment("bra-1", 3)], materialsById, null);
        expect(violations).toEqual(["句子 2 第 1 段：通用句不能使用货号 A123 的素材"]);
    });

    it("reports unknown and duplicate sentenceIds", () => {
        const item = { sentenceId: 1, segments: [], downgraded: false };
        const result = validateMatchItems([{ ...item }, { ...item }, { sentenceId: 99, segments: [], downgraded: false }], sentences, pools);
        expect(result.errors).toEqual(expect.arrayContaining([expect.stringContaining("重复输出"), expect.stringContaining("未知的 sentenceId：99")]));
    });

    it("lists sentences with a non-empty pool that the model skipped", () => {
        const result = validateMatchItems([{ sentenceId: 1, segments: [segment("bra-1", 3)], downgraded: false }], sentences, pools);
        expect(result.missingSentenceIds).toEqual([2]);
        expect(result.errors).toEqual([]);
    });

    it("does not require output for sentences whose pool is empty", () => {
        const noPoolSentences = [sentence(), sentence({ sentenceId: 2, needCategory: "通用" })];
        const noPoolPools = buildCandidatePools(noPoolSentences, [bra], []);
        const result = validateMatchItems([{ sentenceId: 1, segments: [segment("bra-1", 3)], downgraded: false }], noPoolSentences, noPoolPools);
        expect(result.missingSentenceIds).toEqual([]);
    });
});

describe("clampSegmentsToHint（时长和校验/clamp）", () => {
    it("keeps segments within the tolerance untouched", () => {
        const segments = [segment("a", 2.5), segment("b", 2.0)];
        expect(clampSegmentsToHint(segments, 4.5)).toEqual(segments);
    });

    it("keeps under-length segments for the gap report instead of padding", () => {
        const segments = [segment("a", 2.0)];
        expect(clampSegmentsToHint(segments, 4.5)).toEqual(segments);
    });

    it("trims the last segment down to the hint when the total overshoots", () => {
        const segments = [segment("a", 2.5), segment("b", 2.5)];
        expect(clampSegmentsToHint(segments, 4.5)).toEqual([segment("a", 2.5), segment("b", 2.0)]);
        expect(totalSegmentDuration(clampSegmentsToHint(segments, 4.5))).toBe(4.5);
    });

    it("drops the last segment when clamping it would go below 0.5s and the rest already fits", () => {
        const segments = [segment("a", 2.9), segment("b", 2.0)];
        expect(clampSegmentsToHint(segments, 3.2)).toEqual([segment("a", 2.9)]);
    });

    it("leaves segments unchanged when neither clamping nor dropping can reach the tolerance", () => {
        const segments = [segment("a", 3.0), segment("b", 2.0), segment("c", 2.0)];
        expect(clampSegmentsToHint(segments, 4.5)).toEqual(segments);
    });
});

describe("assembleTimelineItems", () => {
    const bra = material("bra-1", { duration: 3 });
    const panty = material("panty-1", { categoryName: "内裤", duration: 2 });
    const sentences = [sentence()];
    const pools = buildCandidatePools(sentences, [bra, panty], []);

    it("fills subtitle/needCategory/duration from the sentence plan", () => {
        const items = assembleTimelineItems(sentences, pools, [{ sentenceId: 1, segments: [segment("bra-1", 3)], downgraded: false }]);
        expect(items).toEqual([{
            sentenceId: 1,
            subtitle: "这款无钢圈文胸，久穿不勒",
            needCategory: "文胸",
            duration: 4.5,
            segments: [segment("bra-1", 3)],
            downgraded: false,
        }]);
    });

    it("computes downgraded authoritatively from substitute usage", () => {
        const items = assembleTimelineItems(sentences, pools, [{ sentenceId: 1, segments: [segment("panty-1", 2), segment("bra-1", 2.5)], downgraded: false }]);
        expect(items[0].downgraded).toBe(true);
    });

    it("keeps an empty segments array for sentences the model skipped", () => {
        const items = assembleTimelineItems(sentences, pools, []);
        expect(items[0].segments).toEqual([]);
        expect(items[0].downgraded).toBe(false);
    });
});

describe("buildGapReport（01 §4.5 服务端权威复核）", () => {
    const bra = material("bra-1", { duration: 3 });
    const general = material("gen-1", { sku: "通用", categoryName: "通用", duration: 3 });

    it("reports no_candidate with the sku/category detail when both layers are empty", () => {
        const sentences = [sentence()];
        const pools = buildCandidatePools(sentences, [], []);
        const items = assembleTimelineItems(sentences, pools, []);
        const report = buildGapReport(sentences, items, pools, SKU);
        expect(report.items).toEqual([{
            sentenceId: 1,
            kind: "no_candidate",
            needCategory: "文胸",
            detail: "货号 A123 无『文胸』分类素材，也无同货号其他分类素材可顶替",
            missingSeconds: 0,
        }]);
    });

    it("reports no_candidate for a 通用 sentence without general materials", () => {
        const sentences = [sentence({ sentenceId: 2, needCategory: "通用" })];
        const pools = buildCandidatePools(sentences, [bra], []);
        const report = buildGapReport(sentences, assembleTimelineItems(sentences, pools, []), pools, SKU);
        expect(report.items[0].detail).toContain("『通用』素材");
    });

    it("reports no_candidate when the model skipped a sentence that has candidates", () => {
        const sentences = [sentence()];
        const pools = buildCandidatePools(sentences, [bra], []);
        const report = buildGapReport(sentences, assembleTimelineItems(sentences, pools, []), pools, SKU);
        expect(report.items[0].kind).toBe("no_candidate");
        expect(report.items[0].detail).toContain("模型未能为该句挑选素材");
    });

    it("reports insufficient with missingSeconds when the total falls short", () => {
        const sentences = [sentence({ durationHint: 4.5 })];
        const pools = buildCandidatePools(sentences, [bra], []);
        const items = assembleTimelineItems(sentences, pools, [{ sentenceId: 1, segments: [segment("bra-1", 2.0)], downgraded: false }]);
        const report = buildGapReport(sentences, items, pools, SKU);
        expect(report.items[0]).toEqual(expect.objectContaining({ kind: "insufficient", missingSeconds: 2.5 }));
        expect(report.items[0].detail).toContain("还差 2.5 秒");
    });

    it("stays silent for fully covered sentences", () => {
        const sentences = [sentence({ sentenceId: 1, durationHint: 3 }), sentence({ sentenceId: 2, needCategory: "通用", durationHint: 3 })];
        const pools = buildCandidatePools(sentences, [bra], [general]);
        const items = assembleTimelineItems(sentences, pools, [
            { sentenceId: 1, segments: [segment("bra-1", 3)], downgraded: false },
            { sentenceId: 2, segments: [segment("gen-1", 3)], downgraded: false },
        ]);
        expect(buildGapReport(sentences, items, pools, SKU)).toEqual({ items: [] });
    });
});

describe("matchTimeline", () => {
    const sentences = [
        sentence({ sentenceId: 1, durationHint: 4.5 }),
        sentence({ sentenceId: 2, needCategory: "通用", durationHint: 3 }),
    ];
    const skuRows = [
        dbRow(material("bra-1", { duration: 3 })),
        dbRow(material("panty-1", { categoryName: "内裤", duration: 2 })),
    ];
    const generalRows = [dbRow(material("gen-1", { sku: "通用", categoryName: "通用", duration: 3 }))];

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.materialFindMany.mockImplementation(async ({ where }: { where: { sku: string } }) => where.sku === "通用" ? generalRows : skuRows);
    });

    it("matches through the LLM and returns a clean timeline", async () => {
        mocks.chatJson.mockResolvedValue({ items: [
            { sentenceId: 1, segments: [{ materialId: "bra-1", inPoint: 0, outPoint: 3, reason: "贴合" }, { materialId: "bra-1", inPoint: 0, outPoint: 1.5, reason: "细节" }], downgraded: false },
            { sentenceId: 2, segments: [{ materialId: "gen-1", inPoint: 0, outPoint: 3, reason: "氛围" }], downgraded: false },
        ] });
        const result = await matchTimeline({ sku: SKU, sentences });
        expect(mocks.chatJson).toHaveBeenCalledTimes(1);
        expect(result.items).toEqual([
            expect.objectContaining({ sentenceId: 1, subtitle: "这款无钢圈文胸，久穿不勒", duration: 4.5, downgraded: false }),
            expect.objectContaining({ sentenceId: 2, needCategory: "通用", duration: 3, downgraded: false }),
        ]);
        expect(result.items[0].segments).toHaveLength(2);
        expect(result.gapReport).toEqual({ items: [] });
    });

    it("feeds per-sentence candidate pools instead of the whole library", async () => {
        mocks.chatJson.mockResolvedValue({ items: [] });
        await matchTimeline({ sku: SKU, sentences }).catch(() => undefined);
        const userPrompt = mocks.chatJson.mock.calls[0][1] as string;
        expect(userPrompt).toContain("\"sku\":\"A123\"");
        expect(userPrompt).toContain("candidatesBySentence");
        expect(userPrompt).toContain("\"bra-1\"");
        expect(userPrompt).toContain("\"panty-1\"");
        expect(userPrompt).toContain("\"substitute\":true");
    });

    it("retries once with the business errors appended and then succeeds", async () => {
        mocks.chatJson
            .mockResolvedValueOnce({ items: [{ sentenceId: 1, segments: [{ materialId: "gen-1", inPoint: 0, outPoint: 4.5, reason: "" }], downgraded: false }] })
            .mockResolvedValueOnce({ items: [
                { sentenceId: 1, segments: [{ materialId: "bra-1", inPoint: 0, outPoint: 3, reason: "贴合" }, { materialId: "bra-1", inPoint: 0, outPoint: 1.5, reason: "细节" }], downgraded: false },
                { sentenceId: 2, segments: [{ materialId: "gen-1", inPoint: 0, outPoint: 3, reason: "氛围" }], downgraded: false },
            ] });
        const result = await matchTimeline({ sku: SKU, sentences });
        expect(mocks.chatJson).toHaveBeenCalledTimes(2);
        const retryPrompt = mocks.chatJson.mock.calls[1][1] as string;
        expect(retryPrompt).toContain("未通过业务校验");
        expect(retryPrompt).toContain("不在该句候选池内");
        expect(result.gapReport).toEqual({ items: [] });
    });

    it("marks a sentence downgraded when it uses substitute materials", async () => {
        mocks.chatJson.mockResolvedValue({ items: [{ sentenceId: 1, segments: [{ materialId: "bra-1", inPoint: 0, outPoint: 3, reason: "贴合" }, { materialId: "panty-1", inPoint: 0, outPoint: 1.5, reason: "顶替" }], downgraded: true }] });
        const result = await matchTimeline({ sku: SKU, sentences });
        expect(result.items[0].downgraded).toBe(true);
        expect(result.items[1].segments).toEqual([]);
        expect(result.gapReport.items[0]).toEqual(expect.objectContaining({ sentenceId: 2, kind: "no_candidate" }));
    });

    it("degrades persistently missing sentences to no_candidate after the retry", async () => {
        mocks.chatJson.mockResolvedValue({ items: [{ sentenceId: 1, segments: [{ materialId: "bra-1", inPoint: 0, outPoint: 3, reason: "贴合" }, { materialId: "bra-1", inPoint: 0, outPoint: 1.5, reason: "细节" }], downgraded: false }] });
        const result = await matchTimeline({ sku: SKU, sentences });
        expect(mocks.chatJson).toHaveBeenCalledTimes(2);
        expect(result.items[1].segments).toEqual([]);
        expect(result.gapReport.items[0]).toEqual(expect.objectContaining({ sentenceId: 2, kind: "no_candidate", detail: expect.stringContaining("模型未能为该句挑选素材") }));
    });

    it("fails with a 502 error when validation still fails after the retry", async () => {
        mocks.chatJson.mockResolvedValue({ items: [{ sentenceId: 1, segments: [{ materialId: "gen-1", inPoint: 0, outPoint: 3, reason: "" }], downgraded: false }] });
        await expect(matchTimeline({ sku: SKU, sentences })).rejects.toThrow(/匹配结果未通过校验[\s\S]*候选池/);
        expect(mocks.chatJson).toHaveBeenCalledTimes(2);
    });

    it("skips the LLM entirely when every pool is empty", async () => {
        mocks.materialFindMany.mockResolvedValue([]);
        const result = await matchTimeline({ sku: SKU, sentences });
        expect(mocks.chatJson).not.toHaveBeenCalled();
        expect(result.items.map((item) => item.segments)).toEqual([[], []]);
        expect(result.gapReport.items.map((item) => item.kind)).toEqual(["no_candidate", "no_candidate"]);
    });

    it("rejects an empty sentence list", async () => {
        await expect(matchTimeline({ sku: SKU, sentences: [] })).rejects.toThrow(/没有可匹配的句子/);
        expect(mocks.materialFindMany).not.toHaveBeenCalled();
    });
});

describe("loadPoolMaterials（P2 F4 露产品复核硬闸门）", () => {
    const sentences = [
        sentence({ sentenceId: 1, durationHint: 4.5 }),
        sentence({ sentenceId: 2, needCategory: "通用", durationHint: 3 }),
    ];
    const skuRows = [dbRow(material("bra-1", { duration: 3 }))];
    const generalRows = [
        { ...dbRow(material("gen-clean", { sku: "通用", categoryName: "通用", duration: 3 })), productVisible: false, reviewStatus: "none" },
        { ...dbRow(material("gen-unknown", { sku: "通用", categoryName: "通用", duration: 3 })), productVisible: null, reviewStatus: "none" },
        { ...dbRow(material("gen-warn", { sku: "通用", categoryName: "通用", duration: 3 })), productVisible: true, reviewStatus: "none" },
        { ...dbRow(material("gen-ok", { sku: "通用", categoryName: "通用", duration: 3 })), productVisible: true, reviewStatus: "warn_confirmed" },
    ];

    beforeEach(() => {
        vi.clearAllMocks();
        // 模拟 SQL 语义：NOT(productVisible=true AND reviewStatus="none") 把"疑似露产品且未人工确认"的通用素材挡在池外
        mocks.materialFindMany.mockImplementation(async ({ where }: { where: { sku: string; NOT?: { productVisible: boolean; reviewStatus: string } } }) => {
            if (where.sku !== "通用") return skuRows;
            return generalRows.filter((row) => !(where.NOT && row.productVisible === true && row.reviewStatus === "none"));
        });
        mocks.chatJson.mockResolvedValue({ items: [] });
    });

    it("adds the review gate condition to the 通用 pool query only", async () => {
        await matchTimeline({ sku: SKU, sentences }).catch(() => undefined);
        const generalArgs = mocks.materialFindMany.mock.calls.map(([args]) => args as { where: { sku: string } }).find((args) => args.where.sku === "通用")!;
        expect(generalArgs.where).toEqual({ sku: "通用", status: "active", tagStatus: "done", NOT: { productVisible: true, reviewStatus: "none" } });
        const skuArgs = mocks.materialFindMany.mock.calls.map(([args]) => args as { where: { sku: string } }).find((args) => args.where.sku === SKU)!;
        expect(skuArgs.where).toEqual({ sku: SKU, status: "active", tagStatus: "done" });
    });

    it("keeps unreviewed product-visible general materials out of the pool and confirmed ones in", async () => {
        await matchTimeline({ sku: SKU, sentences }).catch(() => undefined);
        const userPrompt = mocks.chatJson.mock.calls[0][1] as string;
        expect(userPrompt).toContain("gen-clean");
        expect(userPrompt).toContain("gen-unknown");
        expect(userPrompt).toContain("gen-ok");
        expect(userPrompt).not.toContain("gen-warn");
    });
});

describe("rematchSentence（P2 F1 单句重匹配）", () => {
    const sentences = [
        sentence({ sentenceId: 1, durationHint: 4.5 }),
        sentence({ sentenceId: 2, needCategory: "通用", durationHint: 3 }),
    ];
    const skuRows = [
        dbRow(material("bra-1", { duration: 3 })),
        dbRow(material("panty-1", { categoryName: "内裤", duration: 2 })),
    ];
    const generalRows = [dbRow(material("gen-1", { sku: "通用", categoryName: "通用", duration: 3 }))];

    const item1: TimelineItem = {
        sentenceId: 1,
        subtitle: sentences[0].text,
        needCategory: "文胸",
        duration: 4.5,
        segments: [{ materialId: "panty-1", inPoint: 0, outPoint: 2, reason: "旧匹配" }],
        downgraded: true,
    };
    const item2: TimelineItem = {
        sentenceId: 2,
        subtitle: sentences[1].text,
        needCategory: "通用",
        duration: 3,
        segments: [{ materialId: "gen-1", inPoint: 0, outPoint: 3, reason: "氛围" }],
        downgraded: false,
    };

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.materialFindMany.mockImplementation(async ({ where }: { where: { sku: string } }) => where.sku === "通用" ? generalRows : skuRows);
    });

    it("rematches only the target sentence and keeps other items untouched", async () => {
        mocks.chatJson.mockResolvedValue({ items: [
            { sentenceId: 1, segments: [{ materialId: "bra-1", inPoint: 0, outPoint: 3, reason: "贴合" }, { materialId: "bra-1", inPoint: 0, outPoint: 1.5, reason: "细节" }], downgraded: false },
        ] });
        const result = await rematchSentence({ sku: SKU, sentences }, sentences[0], [item1, item2]);
        expect(mocks.chatJson).toHaveBeenCalledTimes(1);
        const userPrompt = mocks.chatJson.mock.calls[0][1] as string;
        expect(userPrompt).toContain("\"sentenceId\":1");
        expect(userPrompt).not.toContain("\"sentenceId\":2");
        expect(result.items).toHaveLength(2);
        expect(result.items[0]).toEqual({
            sentenceId: 1,
            subtitle: "这款无钢圈文胸，久穿不勒",
            needCategory: "文胸",
            duration: 4.5,
            segments: [
                { materialId: "bra-1", inPoint: 0, outPoint: 3, reason: "贴合" },
                { materialId: "bra-1", inPoint: 0, outPoint: 1.5, reason: "细节" },
            ],
            downgraded: false,
        });
        expect(result.items[1]).toEqual(item2);
        expect(result.gapReport).toEqual({ items: [] });
    });

    it("recomputes the gap report over the whole timeline", async () => {
        mocks.chatJson.mockResolvedValue({ items: [{ sentenceId: 1, segments: [{ materialId: "bra-1", inPoint: 0, outPoint: 3, reason: "贴合" }], downgraded: false }] });
        const result = await rematchSentence({ sku: SKU, sentences }, sentences[0], [item1, item2]);
        expect(result.items[1]).toEqual(item2);
        expect(result.gapReport.items).toEqual([expect.objectContaining({ sentenceId: 1, kind: "insufficient", missingSeconds: 1.5 })]);
    });

    it("skips the LLM when the target sentence has no candidates", async () => {
        mocks.materialFindMany.mockResolvedValue([]);
        const result = await rematchSentence({ sku: SKU, sentences }, sentences[0], [item1, item2]);
        expect(mocks.chatJson).not.toHaveBeenCalled();
        expect(result.items[0].segments).toEqual([]);
        expect(result.items[1]).toEqual(item2);
        expect(result.gapReport.items.map((gap) => gap.kind)).toEqual(["no_candidate", "no_candidate"]);
    });

    it("appends the rematched item when the sentence is missing from current items", async () => {
        mocks.chatJson.mockResolvedValue({ items: [{ sentenceId: 2, segments: [{ materialId: "gen-1", inPoint: 0, outPoint: 3, reason: "氛围" }], downgraded: false }] });
        const completeItem1: TimelineItem = { ...item1, segments: [{ materialId: "bra-1", inPoint: 0, outPoint: 3, reason: "旧" }, { materialId: "bra-1", inPoint: 0, outPoint: 1.5, reason: "旧" }] };
        const result = await rematchSentence({ sku: SKU, sentences }, sentences[1], [completeItem1]);
        expect(result.items).toHaveLength(2);
        expect(result.items[0]).toEqual(completeItem1);
        expect(result.items[1]).toEqual(expect.objectContaining({ sentenceId: 2, subtitle: sentences[1].text }));
        expect(result.gapReport).toEqual({ items: [] });
    });

    it("retries once with the business errors appended, like matchTimeline", async () => {
        mocks.chatJson
            .mockResolvedValueOnce({ items: [{ sentenceId: 1, segments: [{ materialId: "gen-1", inPoint: 0, outPoint: 3, reason: "" }], downgraded: false }] })
            .mockResolvedValueOnce({ items: [{ sentenceId: 1, segments: [{ materialId: "bra-1", inPoint: 0, outPoint: 3, reason: "贴合" }], downgraded: false }] });
        const result = await rematchSentence({ sku: SKU, sentences }, sentences[0], [item1, item2]);
        expect(mocks.chatJson).toHaveBeenCalledTimes(2);
        const retryPrompt = mocks.chatJson.mock.calls[1][1] as string;
        expect(retryPrompt).toContain("未通过业务校验");
        expect(result.items[0].segments).toEqual([{ materialId: "bra-1", inPoint: 0, outPoint: 3, reason: "贴合" }]);
        expect(result.items[1]).toEqual(item2);
    });

    it("rejects a sentence outside the script plan", async () => {
        await expect(rematchSentence({ sku: SKU, sentences }, sentence({ sentenceId: 99 }), [item1])).rejects.toThrow(/不在文案分镜里/);
        expect(mocks.chatJson).not.toHaveBeenCalled();
    });
});

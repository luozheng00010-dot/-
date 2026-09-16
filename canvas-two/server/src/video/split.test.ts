import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    categoryFindMany: vi.fn(),
    chatJson: vi.fn(),
}));

vi.mock("../db.js", () => ({ prisma: { videoCategory: { findMany: mocks.categoryFindMany } } }));
vi.mock("./llm.js", () => ({
    chatJson: mocks.chatJson,
    VideoLlmError: class VideoLlmError extends Error { status = 502; },
}));

import { buildSplitPrompt, buildSplitResultSchema, normalizeSentenceIds, sentencePlanSchema, splitSentences, type SentencePlan } from "./split.js";

const categoryRows = ["文胸", "内裤", "通用"].map((name, index) => ({ id: `cat-${index}`, name, isSystem: true, sortOrder: index, createdAt: new Date() }));

function plan(overrides: Partial<SentencePlan> = {}): SentencePlan {
    return { sentenceId: 1, text: "这款无钢圈文胸，久穿不勒", needCategory: "文胸", durationHint: 4.5, visualNote: "上身贴合效果", ...overrides };
}

describe("sentencePlanSchema", () => {
    it("accepts a valid plan", () => {
        expect(sentencePlanSchema.parse(plan())).toEqual(plan());
    });

    it("rejects out-of-range durationHint values", () => {
        expect(() => sentencePlanSchema.parse(plan({ durationHint: 0.1 }))).toThrow(/至少 0\.5 秒/);
        expect(() => sentencePlanSchema.parse(plan({ durationHint: 30.5 }))).toThrow(/最长 30 秒/);
    });

    it("rejects over-long text and visualNote", () => {
        expect(() => sentencePlanSchema.parse(plan({ text: "长".repeat(201) }))).toThrow(/单句最长 200 字/);
        expect(() => sentencePlanSchema.parse(plan({ visualNote: "提".repeat(121) }))).toThrow(/画面提示最长 120 字/);
    });

    it("rejects non-positive sentenceId and empty text", () => {
        expect(() => sentencePlanSchema.parse(plan({ sentenceId: 0 }))).toThrow(/sentenceId/);
        expect(() => sentencePlanSchema.parse(plan({ text: "  " }))).toThrow(/句子文本不能为空/);
    });
});

describe("buildSplitResultSchema", () => {
    it("reports a hallucinated category with the available list", () => {
        const schema = buildSplitResultSchema(["文胸", "内裤", "通用"]);
        expect(() => schema.parse({ sentences: [plan(), plan({ sentenceId: 2, needCategory: "连衣裙" })] })).toThrow(/分类「连衣裙」不存在[\s\S]*文胸\/内裤\/通用/);
    });

    it("rejects duplicate sentenceIds", () => {
        const schema = buildSplitResultSchema(["文胸"]);
        expect(() => schema.parse({ sentences: [plan(), plan()] })).toThrow(/sentenceId 1 重复/);
    });

    it("requires at least one sentence", () => {
        const schema = buildSplitResultSchema(["文胸"]);
        expect(() => schema.parse({ sentences: [] })).toThrow(/至少要有一句/);
    });
});

describe("buildSplitPrompt", () => {
    it("injects the dynamic category list", () => {
        const prompt = buildSplitPrompt(["文胸", "内裤", "通用"]);
        expect(prompt).toContain("只能从这些分类中选：文胸/内裤/通用");
        expect(prompt).toContain("durationHint = 字数 ÷ 4.5");
        expect(prompt).toContain("每句 8~25 字");
        expect(prompt).toContain("只输出 JSON");
    });
});

describe("normalizeSentenceIds", () => {
    it("sorts by id and renumbers from 1", () => {
        const result = normalizeSentenceIds([plan({ sentenceId: 3, text: "第三句" }), plan({ sentenceId: 1, text: "第一句" })]);
        expect(result.map((item) => item.sentenceId)).toEqual([1, 2]);
        expect(result.map((item) => item.text)).toEqual(["第一句", "第三句"]);
    });
});

describe("splitSentences", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.categoryFindMany.mockResolvedValue(categoryRows);
    });

    it("splits via chatJson with the dynamic category prompt and renumbered ids", async () => {
        mocks.chatJson.mockResolvedValue({ sentences: [plan({ sentenceId: 5 }), plan({ sentenceId: 2, text: "上身超柔软", needCategory: "通用" })] });
        const sentences = await splitSentences("这款无钢圈文胸，久穿不勒。上身超柔软。");
        expect(sentences.map((item) => item.sentenceId)).toEqual([1, 2]);
        expect(mocks.chatJson).toHaveBeenCalledTimes(1);
        const [system, user, schema] = mocks.chatJson.mock.calls[0];
        expect(system).toContain("文胸/内裤/通用");
        expect(user).toContain("这款无钢圈文胸，久穿不勒。上身超柔软。");
        expect(() => (schema as ReturnType<typeof buildSplitResultSchema>).parse({ sentences: [plan({ needCategory: "幻觉分类" })] })).toThrow(/幻觉分类/);
    });

    it("only injects enabled categories into the prompt（P2 F6 停用分类不再参与判定）", async () => {
        const withDisabled: Array<{ id: string; name: string; isSystem: boolean; sortOrder: number; enabled?: boolean; createdAt: Date }> = [
            ...categoryRows,
            { id: "cat-x", name: "泳装", isSystem: false, sortOrder: 9, enabled: false, createdAt: new Date() },
        ];
        mocks.categoryFindMany.mockImplementation(async ({ where }: { where?: { enabled?: boolean } }) =>
            where?.enabled ? withDisabled.filter((row) => row.enabled !== false) : withDisabled);
        mocks.chatJson.mockResolvedValue({ sentences: [plan()] });
        await splitSentences("文案");
        expect(mocks.categoryFindMany).toHaveBeenCalledWith({ where: { enabled: true }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] });
        const system = mocks.chatJson.mock.calls[0][0] as string;
        expect(system).toContain("文胸/内裤/通用");
        expect(system).not.toContain("泳装");
    });

    it("rejects blank text before calling the model", async () => {
        await expect(splitSentences("   ")).rejects.toThrow(/文案内容为空/);
        expect(mocks.chatJson).not.toHaveBeenCalled();
    });

    it("fails when the category table is empty", async () => {
        mocks.categoryFindMany.mockResolvedValue([]);
        await expect(splitSentences("文案")).rejects.toThrow(/素材分类未初始化/);
        expect(mocks.chatJson).not.toHaveBeenCalled();
    });
});

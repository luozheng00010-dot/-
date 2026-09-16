import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    requireReadyUser: vi.fn(),
    categoryFindMany: vi.fn(),
    skuFindUnique: vi.fn(),
    chatJson: vi.fn(),
    scriptCreate: vi.fn(),
    scriptFindUnique: vi.fn(),
    scriptUpdate: vi.fn(),
    timelineCreate: vi.fn(),
    timelineFindUnique: vi.fn(),
    timelineUpdate: vi.fn(),
    timelineAggregate: vi.fn(),
    materialFindMany: vi.fn(),
}));

vi.mock("../access.js", () => ({ requireReadyUser: mocks.requireReadyUser }));
vi.mock("../db.js", () => ({ prisma: {
    videoCategory: { findMany: mocks.categoryFindMany },
    videoSku: { findUnique: mocks.skuFindUnique },
    videoScript: { create: mocks.scriptCreate, findUnique: mocks.scriptFindUnique, update: mocks.scriptUpdate },
    videoTimeline: { create: mocks.timelineCreate, findUnique: mocks.timelineFindUnique, update: mocks.timelineUpdate, aggregate: mocks.timelineAggregate },
    videoMaterial: { findMany: mocks.materialFindMany },
} }));
vi.mock("./llm.js", () => ({
    chatJson: mocks.chatJson,
    VideoLlmError: class VideoLlmError extends Error {
        status: number;
        constructor(message: string, status = 502) { super(message); this.status = status; }
    },
}));

import videoScriptsRouter from "./routes-scripts.js";
import type { SentencePlan } from "./split.js";

const user = { id: "11111111-1111-4111-8111-111111111111", username: "tester", role: "member", mustChangePassword: false };
const scriptId = "22222222-2222-4222-8222-222222222222";
const timelineId = "33333333-3333-4333-8333-333333333333";
const categoryRows = ["文胸", "内裤", "通用"].map((name, index) => ({ id: `cat-${index}`, name, isSystem: true, sortOrder: index, createdAt: new Date() }));

const sentences: SentencePlan[] = [
    { sentenceId: 1, text: "这款无钢圈文胸，久穿不勒", needCategory: "文胸", durationHint: 3, visualNote: "上身贴合" },
    { sentenceId: 2, text: "穿上就像没穿一样", needCategory: "通用", durationHint: 3, visualNote: "穿衣动作" },
];

const skuMaterialRows = [{ id: "bra-1", sku: "A123", duration: 3, description: null, shotType: null, motion: null, useCount: 0, category: { name: "文胸" } }];
const generalMaterialRows = [{ id: "gen-1", sku: "通用", duration: 3, description: null, shotType: null, motion: null, useCount: 0, category: { name: "通用" } }];

const llmMatchItems = { items: [
    { sentenceId: 1, segments: [{ materialId: "bra-1", inPoint: 0, outPoint: 3, reason: "贴合" }], downgraded: false },
    { sentenceId: 2, segments: [{ materialId: "gen-1", inPoint: 0, outPoint: 3, reason: "氛围" }], downgraded: false },
] };

function scriptRow(overrides: Record<string, unknown> = {}) {
    return { id: scriptId, title: "无钢圈文胸", sku: "A123", rawText: "这款无钢圈文胸，久穿不勒。", sentences: null, status: "draft", createdAt: new Date(), ...overrides };
}

function app() {
    const value = express();
    value.use(express.json());
    value.use((req, _res, next) => { (req as unknown as { user: typeof user }).user = user; next(); });
    value.use("/api/video", videoScriptsRouter);
    value.use((error: { status?: number; name?: string; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error.status || (error.name === "ZodError" ? 400 : 500)).json({ error: error.message }));
    return value;
}

describe("video scripts routes", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.requireReadyUser.mockImplementation((_req: express.Request, _res: express.Response, next: express.NextFunction) => next());
        mocks.categoryFindMany.mockResolvedValue(categoryRows);
        mocks.skuFindUnique.mockResolvedValue({ id: "sku-1", name: "A123", createdAt: new Date() });
        mocks.chatJson.mockResolvedValue(llmMatchItems);
        mocks.scriptCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: scriptId, sentences: null, createdAt: new Date(), ...data }));
        mocks.scriptFindUnique.mockResolvedValue(null);
        mocks.scriptUpdate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: scriptId, title: "标题", sku: "A123", rawText: "文案", createdAt: new Date(), ...data }));
        mocks.timelineCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: timelineId, createdAt: new Date(), ...data }));
        mocks.timelineFindUnique.mockResolvedValue(null);
        mocks.timelineUpdate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: timelineId, scriptId, createdAt: new Date(), ...data }));
        mocks.timelineAggregate.mockResolvedValue({ _max: { version: 1 } });
        mocks.materialFindMany.mockImplementation(async ({ where }: { where: { sku?: string; id?: { in: string[] } } }) => {
            if (where.id) return where.id.in.includes("bra-1") ? skuMaterialRows : where.id.in.includes("gen-1") ? generalMaterialRows : [];
            return where.sku === "通用" ? generalMaterialRows : skuMaterialRows;
        });
    });

    it("requires a logged-in ready user", async () => {
        mocks.requireReadyUser.mockImplementationOnce((_req: express.Request, _res: express.Response, next: express.NextFunction) => next(Object.assign(new Error("请先登录"), { status: 401 })));
        const response = await request(app()).get(`/api/video/scripts/${scriptId}`);
        expect(response.status).toBe(401);
        expect(mocks.scriptFindUnique).not.toHaveBeenCalled();
    });

    it("creates a draft script", async () => {
        const response = await request(app()).post("/api/video/scripts").send({ title: "无钢圈文胸", sku: "A123", rawText: "这款无钢圈文胸，久穿不勒。" });
        expect(response.status).toBe(201);
        expect(response.body.script).toEqual({ id: scriptId, title: "无钢圈文胸", sku: "A123", rawText: "这款无钢圈文胸，久穿不勒。", sentences: null, status: "draft" });
        expect(mocks.scriptCreate).toHaveBeenCalledWith({ data: { title: "无钢圈文胸", sku: "A123", rawText: "这款无钢圈文胸，久穿不勒。", createdById: user.id, status: "draft" } });
    });

    it("validates the create payload", async () => {
        const noTitle = await request(app()).post("/api/video/scripts").send({ sku: "A123", rawText: "文案" });
        expect(noTitle.status).toBe(400);
        expect(noTitle.body.error).toContain("请输入标题");
        const longText = await request(app()).post("/api/video/scripts").send({ title: "t", sku: "A123", rawText: "字".repeat(5001) });
        expect(longText.status).toBe(400);
        expect(longText.body.error).toContain("5000");
        expect(mocks.scriptCreate).not.toHaveBeenCalled();
    });

    it("rejects a script whose sku has not been created yet", async () => {
        mocks.skuFindUnique.mockResolvedValue(null);
        const response = await request(app()).post("/api/video/scripts").send({ title: "无钢圈文胸", sku: "A999", rawText: "文案" });
        expect(response.status).toBe(400);
        expect(response.body.error).toContain("货号不存在，请先在下拉框中添加");
        expect(mocks.skuFindUnique).toHaveBeenCalledWith({ where: { name: "A999" } });
        expect(mocks.scriptCreate).not.toHaveBeenCalled();
    });

    it("returns a script with its sentences", async () => {
        mocks.scriptFindUnique.mockResolvedValue({ id: scriptId, title: "无钢圈文胸", sku: "A123", rawText: "文案", sentences, status: "split", createdAt: new Date() });
        const response = await request(app()).get(`/api/video/scripts/${scriptId}`);
        expect(response.status).toBe(200);
        expect(response.body.script).toEqual({ id: scriptId, title: "无钢圈文胸", sku: "A123", rawText: "文案", sentences, status: "split" });
    });

    it("returns 404 for an unknown script", async () => {
        const response = await request(app()).get(`/api/video/scripts/${scriptId}`);
        expect(response.status).toBe(404);
        expect(response.body.error).toContain("文案不存在");
    });

    it("splits a script and persists sentences with status=split", async () => {
        mocks.scriptFindUnique.mockResolvedValue(scriptRow());
        mocks.chatJson.mockResolvedValue({ sentences });
        const response = await request(app()).post(`/api/video/scripts/${scriptId}/split`);
        expect(response.status).toBe(200);
        expect(response.body.script.status).toBe("split");
        expect(response.body.script.sentences).toHaveLength(2);
        expect(mocks.chatJson.mock.calls[0][0]).toContain("文胸/内裤/通用");
        expect(mocks.scriptUpdate).toHaveBeenCalledWith({ where: { id: scriptId }, data: { sentences, status: "split" } });
    });

    it("returns 404 when splitting an unknown script", async () => {
        const response = await request(app()).post(`/api/video/scripts/${scriptId}/split`);
        expect(response.status).toBe(404);
        expect(mocks.chatJson).not.toHaveBeenCalled();
    });

    it("matches stored sentences and creates a timeline with version = max + 1", async () => {
        mocks.scriptFindUnique.mockResolvedValue({ id: scriptId, title: "无钢圈文胸", sku: "A123", rawText: "文案", sentences, status: "split", createdAt: new Date() });
        const response = await request(app()).post(`/api/video/scripts/${scriptId}/match`).send({});
        expect(response.status).toBe(201);
        expect(response.body.timeline).toEqual(expect.objectContaining({ id: timelineId, scriptId, version: 2, status: "matched" }));
        expect(response.body.timeline.items).toHaveLength(2);
        expect(response.body.timeline.gapReport).toEqual({ items: [] });
        expect(mocks.timelineCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ scriptId, version: 2, status: "matched" }) });
        expect(mocks.scriptUpdate).toHaveBeenCalledWith({ where: { id: scriptId }, data: { status: "matched" } });
    });

    it("persists sentence overrides before matching", async () => {
        mocks.scriptFindUnique.mockResolvedValue(scriptRow());
        const response = await request(app()).post(`/api/video/scripts/${scriptId}/match`).send({ sentences });
        expect(response.status).toBe(201);
        expect(mocks.scriptUpdate).toHaveBeenNthCalledWith(1, { where: { id: scriptId }, data: { sentences } });
        expect(mocks.scriptUpdate).toHaveBeenNthCalledWith(2, { where: { id: scriptId }, data: { status: "matched" } });
        expect(mocks.timelineCreate).toHaveBeenCalled();
    });

    it("rejects overrides with a hallucinated category", async () => {
        mocks.scriptFindUnique.mockResolvedValue(scriptRow());
        const response = await request(app()).post(`/api/video/scripts/${scriptId}/match`).send({ sentences: [{ ...sentences[0], needCategory: "连衣裙" }] });
        expect(response.status).toBe(400);
        expect(response.body.error).toContain("分类不存在");
        expect(response.body.error).toContain("连衣裙");
        expect(mocks.scriptUpdate).not.toHaveBeenCalled();
        expect(mocks.timelineCreate).not.toHaveBeenCalled();
    });

    it("rejects invalid override payloads", async () => {
        mocks.scriptFindUnique.mockResolvedValue(scriptRow());
        const response = await request(app()).post(`/api/video/scripts/${scriptId}/match`).send({ sentences: [{ ...sentences[0], durationHint: 99 }] });
        expect(response.status).toBe(400);
        expect(mocks.timelineCreate).not.toHaveBeenCalled();
    });

    it("returns 404 when matching an unknown script and 400 when no sentences exist", async () => {
        const notFound = await request(app()).post(`/api/video/scripts/${scriptId}/match`).send({});
        expect(notFound.status).toBe(404);
        mocks.scriptFindUnique.mockResolvedValue({ id: scriptId, title: "无钢圈文胸", sku: "A123", rawText: "文案", sentences: null, status: "draft", createdAt: new Date() });
        const noSentences = await request(app()).post(`/api/video/scripts/${scriptId}/match`).send({});
        expect(noSentences.status).toBe(400);
        expect(noSentences.body.error).toContain("还没有拆句结果");
        expect(mocks.timelineCreate).not.toHaveBeenCalled();
    });

    it("returns a timeline by id", async () => {
        mocks.timelineFindUnique.mockResolvedValue({ id: timelineId, scriptId, version: 1, items: [], gapReport: { items: [] }, status: "matched", createdAt: new Date() });
        const response = await request(app()).get(`/api/video/timelines/${timelineId}`);
        expect(response.status).toBe(200);
        expect(response.body.timeline).toEqual({ id: timelineId, scriptId, version: 1, items: [], gapReport: { items: [] }, status: "matched" });
    });

    it("returns 404 for an unknown timeline", async () => {
        const response = await request(app()).get(`/api/video/timelines/${timelineId}`);
        expect(response.status).toBe(404);
        expect(response.body.error).toContain("时间线不存在");
    });

    it("saves manual timeline edits with version+1 and status=edited", async () => {
        mocks.timelineFindUnique.mockResolvedValue({ id: timelineId, scriptId, version: 1, items: [], gapReport: null, status: "matched", createdAt: new Date() });
        mocks.scriptFindUnique.mockResolvedValue({ id: scriptId, title: "无钢圈文胸", sku: "A123", rawText: "文案", sentences, status: "matched", createdAt: new Date() });
        const items = [{ sentenceId: 1, subtitle: "这款无钢圈文胸，久穿不勒", needCategory: "文胸", duration: 3, segments: [{ materialId: "bra-1", inPoint: 0, outPoint: 3, reason: "贴合" }], downgraded: false }];
        const response = await request(app()).put(`/api/video/timelines/${timelineId}`).send({ items });
        expect(response.status).toBe(200);
        expect(response.body.timeline).toEqual(expect.objectContaining({ id: timelineId, version: 2, status: "edited" }));
        expect(mocks.timelineUpdate).toHaveBeenCalledWith({ where: { id: timelineId }, data: { items, version: 2, status: "edited" } });
    });

    it("rejects edits referencing archived or missing materials", async () => {
        mocks.timelineFindUnique.mockResolvedValue({ id: timelineId, scriptId, version: 1, items: [], gapReport: null, status: "matched", createdAt: new Date() });
        mocks.scriptFindUnique.mockResolvedValue({ id: scriptId, title: "无钢圈文胸", sku: "A123", rawText: "文案", sentences, status: "matched", createdAt: new Date() });
        const items = [{ sentenceId: 1, subtitle: "句子", needCategory: "文胸", duration: 3, segments: [{ materialId: "gone-1", inPoint: 0, outPoint: 2, reason: "" }], downgraded: false }];
        const response = await request(app()).put(`/api/video/timelines/${timelineId}`).send({ items });
        expect(response.status).toBe(400);
        expect(response.body.error).toContain("不存在或已归档");
        expect(mocks.timelineUpdate).not.toHaveBeenCalled();
    });

    it("rejects edits with an illegal segment or a 通用 sentence using a sku material", async () => {
        mocks.timelineFindUnique.mockResolvedValue({ id: timelineId, scriptId, version: 1, items: [], gapReport: null, status: "matched", createdAt: new Date() });
        mocks.scriptFindUnique.mockResolvedValue({ id: scriptId, title: "无钢圈文胸", sku: "A123", rawText: "文案", sentences, status: "matched", createdAt: new Date() });
        const overshoot = [{ sentenceId: 1, subtitle: "句子", needCategory: "文胸", duration: 3, segments: [{ materialId: "bra-1", inPoint: 0, outPoint: 9.9, reason: "" }], downgraded: false }];
        const overshootResponse = await request(app()).put(`/api/video/timelines/${timelineId}`).send({ items: overshoot });
        expect(overshootResponse.status).toBe(400);
        expect(overshootResponse.body.error).toContain("段时长必须在 0.5 秒到素材时长");
        const generalWithSku = [{ sentenceId: 2, subtitle: "句子", needCategory: "通用", duration: 3, segments: [{ materialId: "bra-1", inPoint: 0, outPoint: 3, reason: "" }], downgraded: false }];
        const generalResponse = await request(app()).put(`/api/video/timelines/${timelineId}`).send({ items: generalWithSku });
        expect(generalResponse.status).toBe(400);
        expect(generalResponse.body.error).toContain("通用句不能使用货号");
        expect(mocks.timelineUpdate).not.toHaveBeenCalled();
    });

    it("returns 404 when editing an unknown timeline", async () => {
        const items = [{ sentenceId: 1, subtitle: "句子", needCategory: "文胸", duration: 3, segments: [{ materialId: "bra-1", inPoint: 0, outPoint: 3, reason: "" }], downgraded: false }];
        const response = await request(app()).put(`/api/video/timelines/${timelineId}`).send({ items });
        expect(response.status).toBe(404);
        expect(mocks.timelineUpdate).not.toHaveBeenCalled();
    });

    // ===== 单句重匹配（P2 F1） =====

    const rematchTimelineItems = [
        { sentenceId: 1, subtitle: "这款无钢圈文胸，久穿不勒", needCategory: "文胸", duration: 3, segments: [{ materialId: "bra-1", inPoint: 0, outPoint: 3, reason: "贴合" }], downgraded: false },
        { sentenceId: 2, subtitle: "穿上就像没穿一样", needCategory: "通用", duration: 3, segments: [{ materialId: "gen-1", inPoint: 0, outPoint: 2, reason: "旧氛围" }], downgraded: false },
    ];

    it("rematches a single sentence, keeps others untouched and bumps the version", async () => {
        mocks.timelineFindUnique.mockResolvedValue({ id: timelineId, scriptId, version: 3, items: rematchTimelineItems, gapReport: { items: [] }, status: "matched", createdAt: new Date() });
        mocks.scriptFindUnique.mockResolvedValue({ id: scriptId, title: "无钢圈文胸", sku: "A123", rawText: "文案", sentences, status: "matched", createdAt: new Date() });
        mocks.chatJson.mockResolvedValue({ items: [{ sentenceId: 2, segments: [{ materialId: "gen-1", inPoint: 0, outPoint: 3, reason: "新氛围" }], downgraded: false }] });
        const response = await request(app()).post(`/api/video/timelines/${timelineId}/rematch`).send({ sentenceId: 2 });
        expect(response.status).toBe(200);
        expect(response.body.timeline).toEqual(expect.objectContaining({ id: timelineId, scriptId, version: 4, status: "edited" }));
        // 只有目标句进 prompt，其余句不重跑
        expect(mocks.chatJson).toHaveBeenCalledTimes(1);
        const userPrompt = mocks.chatJson.mock.calls[0][1] as string;
        expect(userPrompt).toContain("穿上就像没穿一样");
        expect(userPrompt).not.toContain("这款无钢圈文胸");
        // 句子 1 原样保留，句子 2 替换为新匹配结果，gapReport 重算
        const saved = mocks.timelineUpdate.mock.calls[0][0];
        expect(saved.data.items[0]).toEqual(rematchTimelineItems[0]);
        expect(saved.data.items[1]).toEqual(expect.objectContaining({
            sentenceId: 2,
            subtitle: "穿上就像没穿一样",
            segments: [{ materialId: "gen-1", inPoint: 0, outPoint: 3, reason: "新氛围" }],
        }));
        expect(saved.data.gapReport).toEqual({ items: [] });
        expect(saved.where).toEqual({ id: timelineId });
        expect(saved.data).toEqual(expect.objectContaining({ version: 4, status: "edited" }));
    });

    it("returns 404 when rematching an unknown timeline and 400 for an unknown sentence", async () => {
        const notFound = await request(app()).post(`/api/video/timelines/${timelineId}/rematch`).send({ sentenceId: 1 });
        expect(notFound.status).toBe(404);
        mocks.timelineFindUnique.mockResolvedValue({ id: timelineId, scriptId, version: 1, items: rematchTimelineItems, gapReport: null, status: "matched", createdAt: new Date() });
        mocks.scriptFindUnique.mockResolvedValue({ id: scriptId, title: "无钢圈文胸", sku: "A123", rawText: "文案", sentences, status: "matched", createdAt: new Date() });
        const unknownSentence = await request(app()).post(`/api/video/timelines/${timelineId}/rematch`).send({ sentenceId: 99 });
        expect(unknownSentence.status).toBe(400);
        expect(unknownSentence.body.error).toContain("句子 99 不存在");
        expect(mocks.chatJson).not.toHaveBeenCalled();
        expect(mocks.timelineUpdate).not.toHaveBeenCalled();
    });

    it("returns 400 when rematching a script without sentences or with an invalid body", async () => {
        mocks.timelineFindUnique.mockResolvedValue({ id: timelineId, scriptId, version: 1, items: [], gapReport: null, status: "matched", createdAt: new Date() });
        mocks.scriptFindUnique.mockResolvedValue({ id: scriptId, title: "无钢圈文胸", sku: "A123", rawText: "文案", sentences: null, status: "draft", createdAt: new Date() });
        const noSentences = await request(app()).post(`/api/video/timelines/${timelineId}/rematch`).send({ sentenceId: 1 });
        expect(noSentences.status).toBe(400);
        expect(noSentences.body.error).toContain("还没有拆句结果");
        mocks.scriptFindUnique.mockResolvedValue({ id: scriptId, title: "无钢圈文胸", sku: "A123", rawText: "文案", sentences, status: "split", createdAt: new Date() });
        const missingId = await request(app()).post(`/api/video/timelines/${timelineId}/rematch`).send({});
        expect(missingId.status).toBe(400);
        expect(mocks.timelineUpdate).not.toHaveBeenCalled();
    });
});

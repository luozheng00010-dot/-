import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    requireReadyUser: vi.fn(),
    categoryFindUnique: vi.fn(),
    categoryFindMany: vi.fn(),
    skuFindUnique: vi.fn(),
    mediaCreate: vi.fn(),
    materialCreate: vi.fn(),
    materialFindUnique: vi.fn(),
    materialFindMany: vi.fn(),
    materialCount: vi.fn(),
    materialUpdate: vi.fn(),
    materialUpdateMany: vi.fn(),
    materialGroupBy: vi.fn(),
    batchCreate: vi.fn(),
    batchFindUnique: vi.fn(),
    putObject: vi.fn(),
    removeObject: vi.fn(),
}));

vi.mock("../access.js", () => ({ requireReadyUser: mocks.requireReadyUser }));
vi.mock("../db.js", () => {
    const prisma = {
        videoCategory: { findUnique: mocks.categoryFindUnique, findMany: mocks.categoryFindMany },
        videoSku: { findUnique: mocks.skuFindUnique },
        mediaFile: { create: mocks.mediaCreate },
        videoMaterial: { findUnique: mocks.materialFindUnique, findMany: mocks.materialFindMany, count: mocks.materialCount, create: mocks.materialCreate, update: mocks.materialUpdate, updateMany: mocks.materialUpdateMany, groupBy: mocks.materialGroupBy },
        videoIngestBatch: { create: mocks.batchCreate, findUnique: mocks.batchFindUnique },
        $transaction: async (fn: (tx: any) => any) => fn(prisma),
    };
    return { prisma };
});
vi.mock("../storage.js", () => ({ putObject: mocks.putObject, removeObject: mocks.removeObject, getObject: vi.fn(), getPartialObject: vi.fn() }));

import videoMaterialsRouter from "./routes-materials.js";

const user = { id: "11111111-1111-4111-8111-111111111111", username: "tester", role: "member", mustChangePassword: false };
const categoryId = "22222222-2222-4222-8222-222222222222";
const generalCategoryId = "33333333-3333-4333-8333-333333333333";
const materialId = "44444444-4444-4444-8444-444444444444";
const batchId = "55555555-5555-4555-8555-555555555555";
const braCategory = { id: categoryId, name: "文胸", isSystem: true, sortOrder: 1, enabled: true, createdAt: new Date() };
const generalCategory = { id: generalCategoryId, name: "通用", isSystem: true, sortOrder: 3, enabled: true, createdAt: new Date() };

function app() {
    const value = express();
    value.use(express.json());
    value.use((req, _res, next) => { (req as unknown as { user: typeof user }).user = user; next(); });
    value.use("/api/video", videoMaterialsRouter);
    value.use((error: { status?: number; name?: string; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error.status || (error.name === "ZodError" ? 400 : 500)).json({ error: error.message }));
    return value;
}

function uploadRequest() {
    return request(app()).post("/api/video/ingest-batches");
}

describe("video materials routes", () => {
    let sequence = 0;

    beforeEach(() => {
        vi.clearAllMocks();
        sequence = 0;
        mocks.requireReadyUser.mockImplementation((_req: express.Request, _res: express.Response, next: express.NextFunction) => next());
        mocks.categoryFindUnique.mockResolvedValue(braCategory);
        mocks.categoryFindMany.mockResolvedValue([]);
        mocks.skuFindUnique.mockResolvedValue({ id: "sku-1", name: "A123", createdAt: new Date() });
        mocks.mediaCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: `media-${++sequence}`, createdAt: new Date(), ...data }));
        mocks.materialCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: `material-${++sequence}`, tagStatus: "pending", status: "active", createdAt: new Date(), ...data }));
        mocks.batchCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: batchId, doneCount: 0, failedCount: 0, status: "processing", createdAt: new Date(), ...data }));
        mocks.materialFindUnique.mockResolvedValue(null);
        mocks.materialFindMany.mockResolvedValue([]);
        mocks.materialCount.mockResolvedValue(0);
        mocks.materialUpdate.mockResolvedValue(null);
        mocks.materialUpdateMany.mockResolvedValue({ count: 0 });
        mocks.materialGroupBy.mockResolvedValue([]);
        mocks.batchFindUnique.mockResolvedValue(null);
        mocks.putObject.mockResolvedValue(undefined);
        mocks.removeObject.mockResolvedValue(undefined);
    });

    it("requires a logged-in ready user", async () => {
        mocks.requireReadyUser.mockImplementationOnce((_req: express.Request, _res: express.Response, next: express.NextFunction) => next(Object.assign(new Error("请先登录"), { status: 401 })));
        const response = await request(app()).get("/api/video/materials");
        expect(response.status).toBe(401);
        expect(mocks.materialFindMany).not.toHaveBeenCalled();
    });

    it("lists only enabled categories by default and all of them with ?all=1", async () => {
        const disabledCategory = { id: "88888888-8888-4888-8888-888888888888", name: "泳装", isSystem: false, sortOrder: 9, enabled: false, createdAt: new Date() };
        mocks.categoryFindMany.mockImplementation(async ({ where }: { where?: { enabled?: boolean } }) =>
            where?.enabled ? [generalCategory, braCategory] : [generalCategory, disabledCategory, braCategory]);
        const response = await request(app()).get("/api/video/categories");
        expect(response.status).toBe(200);
        expect(mocks.categoryFindMany).toHaveBeenCalledWith({ where: { enabled: true }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] });
        expect(response.body.categories).toEqual([
            { id: generalCategoryId, name: "通用", isSystem: true, sortOrder: 3, enabled: true },
            { id: categoryId, name: "文胸", isSystem: true, sortOrder: 1, enabled: true },
        ]);
        const allResponse = await request(app()).get("/api/video/categories?all=1");
        expect(allResponse.status).toBe(200);
        expect(mocks.categoryFindMany).toHaveBeenLastCalledWith({ orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] });
        expect(allResponse.body.categories).toHaveLength(3);
        expect(allResponse.body.categories[1]).toEqual({ id: disabledCategory.id, name: "泳装", isSystem: false, sortOrder: 9, enabled: false });
    });

    it("creates media files, pending materials and the batch for an upload", async () => {
        const response = await uploadRequest()
            .field("sku", "A123")
            .field("categoryId", categoryId)
            .attach("files", Buffer.from("video-a"), { filename: "a.mp4", contentType: "video/mp4" })
            .attach("files", Buffer.from("video-b"), { filename: "b.mov", contentType: "video/quicktime" });
        expect(response.status).toBe(201);
        expect(response.body.batch).toEqual({ id: expect.stringMatching(/^[0-9a-f-]{36}$/), sku: "A123", categoryId, totalCount: 2, doneCount: 0, failedCount: 0, status: "processing" });
        expect(mocks.putObject).toHaveBeenCalledTimes(2);
        const firstKey = mocks.putObject.mock.calls[0][0] as string;
        const secondKey = mocks.putObject.mock.calls[1][0] as string;
        expect(firstKey).toMatch(/^video\/materials\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.mp4$/);
        expect(secondKey).toMatch(/^video\/materials\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.mov$/);
        expect(mocks.mediaCreate).toHaveBeenCalledTimes(2);
        expect(mocks.mediaCreate).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ ownerId: user.id, createdById: user.id, origin: "video", visibility: "private", mimeType: "video/mp4", fileName: "a.mp4" }),
        }));
        expect(mocks.materialCreate).toHaveBeenCalledTimes(2);
        expect(mocks.materialCreate).toHaveBeenNthCalledWith(1, expect.objectContaining({
            data: expect.objectContaining({ sku: "A123", categoryId, batchId: expect.any(String), mediaFileId: "media-1", fileName: "a.mp4", duration: 0, tagStatus: "pending" }),
        }));
        expect(mocks.batchCreate).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ sku: "A123", categoryId, createdById: user.id, totalCount: 2, status: "processing" }),
        }));
    });

    it("forces the sentinel sku when the category is 通用", async () => {
        mocks.categoryFindUnique.mockResolvedValue(generalCategory);
        const response = await uploadRequest()
            .field("sku", "X9-product")
            .field("categoryId", generalCategoryId)
            .attach("files", Buffer.from("video"), { filename: "scene.mp4", contentType: "video/mp4" });
        expect(response.status).toBe(201);
        expect(response.body.batch.sku).toBe("通用");
        expect(mocks.materialCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ sku: "通用" }) }));
        expect(mocks.batchCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ sku: "通用" }) }));
        // 哨兵值不参与货号管理：通用上传不做"先建后用"校验
        expect(mocks.skuFindUnique).not.toHaveBeenCalled();
    });

    it("rejects an upload when the sku has not been created yet", async () => {
        mocks.skuFindUnique.mockResolvedValue(null);
        const response = await uploadRequest()
            .field("sku", "A999")
            .field("categoryId", categoryId)
            .attach("files", Buffer.from("video"), { filename: "a.mp4", contentType: "video/mp4" });
        expect(response.status).toBe(400);
        expect(response.body.error).toContain("货号不存在，请先在下拉框中添加");
        expect(mocks.skuFindUnique).toHaveBeenCalledWith({ where: { name: "A999" } });
        expect(mocks.putObject).not.toHaveBeenCalled();
        expect(mocks.batchCreate).not.toHaveBeenCalled();
    });

    it("rejects an upload with more than 100 files", async () => {
        let submission = uploadRequest().field("sku", "A123").field("categoryId", categoryId);
        for (let index = 0; index <= 100; index += 1) submission = submission.attach("files", Buffer.from("v"), { filename: `f${index}.mp4`, contentType: "video/mp4" });
        const response = await submission;
        expect(response.status).toBe(400);
        expect(response.body.error).toContain("最多上传 100 个");
        expect(mocks.putObject).not.toHaveBeenCalled();
        expect(mocks.batchCreate).not.toHaveBeenCalled();
    });

    it("rejects non-video mime types", async () => {
        const response = await uploadRequest()
            .field("sku", "A123")
            .field("categoryId", categoryId)
            .attach("files", Buffer.from("text"), { filename: "note.txt", contentType: "text/plain" });
        expect(response.status).toBe(400);
        expect(response.body.error).toContain("不是视频类型");
        expect(mocks.putObject).not.toHaveBeenCalled();
    });

    it("rejects an upload when the category does not exist", async () => {
        mocks.categoryFindUnique.mockResolvedValue(null);
        const response = await uploadRequest()
            .field("sku", "A123")
            .field("categoryId", categoryId)
            .attach("files", Buffer.from("video"), { filename: "a.mp4", contentType: "video/mp4" });
        expect(response.status).toBe(404);
        expect(response.body.error).toContain("素材分类不存在");
    });

    it("rejects an upload into a disabled category", async () => {
        mocks.categoryFindUnique.mockResolvedValue({ ...braCategory, enabled: false });
        const response = await uploadRequest()
            .field("sku", "A123")
            .field("categoryId", categoryId)
            .attach("files", Buffer.from("video"), { filename: "a.mp4", contentType: "video/mp4" });
        expect(response.status).toBe(400);
        expect(response.body.error).toContain("分类已停用");
        expect(mocks.putObject).not.toHaveBeenCalled();
        expect(mocks.batchCreate).not.toHaveBeenCalled();
    });

    it("rejects an upload without files", async () => {
        const response = await uploadRequest().field("sku", "A123").field("categoryId", categoryId);
        expect(response.status).toBe(400);
        expect(response.body.error).toContain("请选择要上传的视频文件");
    });

    it("rejects a missing sku for a non-通用 category", async () => {
        const response = await uploadRequest()
            .field("sku", "")
            .field("categoryId", categoryId)
            .attach("files", Buffer.from("video"), { filename: "a.mp4", contentType: "video/mp4" });
        expect(response.status).toBe(400);
        expect(response.body.error).toContain("请填写货号");
    });

    it("returns batch progress with the first 20 failed materials", async () => {
        mocks.batchFindUnique.mockResolvedValue({ id: batchId, sku: "A123", categoryId, createdById: user.id, totalCount: 3, doneCount: 1, failedCount: 2, status: "partial", createdAt: new Date() });
        mocks.materialFindMany.mockResolvedValue([{ id: materialId, fileName: "a.mp4", tagError: "视觉模型输出未通过校验" }]);
        const response = await request(app()).get(`/api/video/ingest-batches/${batchId}`);
        expect(response.status).toBe(200);
        expect(response.body.batch).toEqual({ id: batchId, sku: "A123", categoryId, totalCount: 3, doneCount: 1, failedCount: 2, status: "partial" });
        expect(response.body.failedMaterials).toEqual([{ id: materialId, fileName: "a.mp4", tagError: "视觉模型输出未通过校验" }]);
        expect(mocks.materialFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { batchId, tagStatus: "failed" }, take: 20 }));
    });

    it("returns 404 for an unknown batch", async () => {
        const response = await request(app()).get(`/api/video/ingest-batches/${batchId}`);
        expect(response.status).toBe(404);
    });

    it("applies the default status filter and pagination to the materials list", async () => {
        const response = await request(app()).get("/api/video/materials");
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ total: 0, items: [] });
        expect(mocks.materialFindMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({ status: "active" }),
            orderBy: { createdAt: "desc" },
            skip: 0,
            take: 24,
        }));
    });

    it("gives the ids filter precedence over other filters", async () => {
        const otherId = "66666666-6666-4666-8666-666666666666";
        const response = await request(app()).get(`/api/video/materials?ids=${materialId},${otherId}&status=archived&sku=zzz`);
        expect(response.status).toBe(200);
        expect(mocks.materialFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: [materialId, otherId] } } }));
    });

    it("rejects more than 200 ids", async () => {
        const hex = (value: number) => value.toString(16).padStart(4, "0");
        const ids = Array.from({ length: 201 }, (_, index) => `${hex(index)}0000-0000-4000-8000-${hex(index)}00000000`).join(",");
        const response = await request(app()).get(`/api/video/materials?ids=${ids}`);
        expect(response.status).toBe(400);
        expect(response.body.error).toContain("200");
    });

    it("filters the materials list by reviewStatus (P2 复核队列)", async () => {
        const response = await request(app()).get("/api/video/materials?reviewStatus=warn_confirmed");
        expect(response.status).toBe(200);
        expect(mocks.materialFindMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({ reviewStatus: "warn_confirmed" }),
        }));
        const invalid = await request(app()).get("/api/video/materials?reviewStatus=bogus");
        expect(invalid.status).toBe(400);
    });

    it("aggregates active+done materials by sku × category with rounded seconds", async () => {
        mocks.materialGroupBy.mockResolvedValue([
            { sku: "通用", categoryId: generalCategoryId, _count: { _all: 2 }, _sum: { duration: 5 } },
            { sku: "A123", categoryId, _count: { _all: 3 }, _sum: { duration: 10.26 } },
        ]);
        mocks.categoryFindMany.mockResolvedValue([{ id: categoryId, name: "文胸" }, { id: generalCategoryId, name: "通用" }]);
        const response = await request(app()).get("/api/video/materials/stats");
        expect(response.status).toBe(200);
        // 只统计参与匹配的真实可用量：active + 打标完成
        expect(mocks.materialGroupBy).toHaveBeenCalledWith({
            by: ["sku", "categoryId"],
            where: { status: "active", tagStatus: "done" },
            _count: { _all: true },
            _sum: { duration: true },
        });
        expect(response.body.rows).toEqual([
            { sku: "A123", categoryId, categoryName: "文胸", count: 3, seconds: 10.3 },
            { sku: "通用", categoryId: generalCategoryId, categoryName: "通用", count: 2, seconds: 5 },
        ]);
    });

    it("returns an empty stats matrix when no materials qualify", async () => {
        const response = await request(app()).get("/api/video/materials/stats");
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ rows: [] });
    });

    it("queues selected materials for retagging and ignores unknown ids", async () => {
        const otherId = "66666666-6666-4666-8666-666666666666";
        mocks.materialUpdateMany.mockResolvedValue({ count: 1 });
        const response = await request(app()).post("/api/video/materials/retag").send({ ids: [materialId, otherId] });
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ queued: 1 });
        expect(mocks.materialUpdateMany).toHaveBeenCalledWith({
            where: { id: { in: [materialId, otherId] } },
            data: { tagStatus: "pending", tagError: null },
        });
    });

    it("caps retag batches at 200 ids and validates uuids", async () => {
        const hex = (value: number) => value.toString(16).padStart(4, "0");
        const ids = Array.from({ length: 201 }, (_, index) => `${hex(index)}0000-0000-4000-8000-${hex(index)}00000000`);
        const tooMany = await request(app()).post("/api/video/materials/retag").send({ ids });
        expect(tooMany.status).toBe(400);
        expect(tooMany.body.error).toContain("200");
        const badId = await request(app()).post("/api/video/materials/retag").send({ ids: ["not-a-uuid"] });
        expect(badId.status).toBe(400);
        expect(mocks.materialUpdateMany).not.toHaveBeenCalled();
    });

    it("updates allowed fields and echoes the material", async () => {
        mocks.materialFindUnique.mockResolvedValue({ id: materialId, sku: "A123", categoryId, fileName: "a.mp4" });
        mocks.materialUpdate.mockResolvedValue({ id: materialId, sku: "A123", categoryId, categoryName: null, fileName: "a.mp4", duration: 3.5, width: 1080, height: 1920, tagStatus: "done", tagError: null, description: "上身贴合", shotType: "特写", motion: "摆放", productVisible: true, reviewStatus: "corrected", status: "archived", createdAt: new Date(), mediaFileId: "media-1", thumbnailMediaId: "media-2", category: { name: "文胸" } });
        const response = await request(app()).patch(`/api/video/materials/${materialId}`).send({ description: "上身贴合", reviewStatus: "corrected", status: "archived" });
        expect(response.status).toBe(200);
        expect(mocks.materialUpdate).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ description: "上身贴合", reviewStatus: "corrected", status: "archived" }),
        }));
        expect(response.body.material).toEqual(expect.objectContaining({ id: materialId, categoryName: "文胸", status: "archived", mediaFileId: "media-1", thumbnailMediaId: "media-2" }));
    });

    it("rejects an empty patch body", async () => {
        const response = await request(app()).patch(`/api/video/materials/${materialId}`).send({});
        expect(response.status).toBe(400);
        expect(response.body.error).toContain("至少传入一个要更新的字段");
        expect(mocks.materialUpdate).not.toHaveBeenCalled();
    });

    it("rejects invalid enum values in a patch", async () => {
        const response = await request(app()).patch(`/api/video/materials/${materialId}`).send({ status: "bogus" });
        expect(response.status).toBe(400);
        const response2 = await request(app()).patch(`/api/video/materials/${materialId}`).send({ reviewStatus: "nope" });
        expect(response2.status).toBe(400);
        expect(mocks.materialUpdate).not.toHaveBeenCalled();
    });

    it("rejects a patch pointing at a missing category", async () => {
        mocks.categoryFindUnique.mockResolvedValue(null);
        const response = await request(app()).patch(`/api/video/materials/${materialId}`).send({ categoryId: "77777777-7777-4777-8777-777777777777" });
        expect(response.status).toBe(400);
        expect(response.body.error).toContain("所选分类不存在");
        expect(mocks.materialUpdate).not.toHaveBeenCalled();
    });

    it("rejects a patch moving a material into a disabled category", async () => {
        mocks.categoryFindUnique.mockResolvedValue({ ...braCategory, enabled: false });
        mocks.materialFindUnique.mockResolvedValue({ id: materialId, sku: "A123", categoryId, fileName: "a.mp4" });
        const response = await request(app()).patch(`/api/video/materials/${materialId}`).send({ categoryId });
        expect(response.status).toBe(400);
        expect(response.body.error).toContain("分类已停用");
        expect(mocks.materialUpdate).not.toHaveBeenCalled();
    });

    it("returns 404 when patching an unknown material", async () => {
        const response = await request(app()).patch(`/api/video/materials/${materialId}`).send({ description: "x" });
        expect(response.status).toBe(404);
        expect(response.body.error).toContain("素材不存在");
    });
});

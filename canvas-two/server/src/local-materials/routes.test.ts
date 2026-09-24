import express, { type ErrorRequestHandler } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    skuCreate: vi.fn(), skuFind: vi.fn(), categoryFind: vi.fn(), materialCreate: vi.fn(), materialUpdate: vi.fn(), materialFind: vi.fn(),
    queueAnalysis: vi.fn(), materialGet: vi.fn(), upload: vi.fn(), cleanup: vi.fn(), upstream: vi.fn(),
}));
vi.mock("../db.js", () => ({ prisma: {
    $transaction: async (fn: any) => fn({}),
    localVideoSku: { create: mocks.skuCreate, findUniqueOrThrow: mocks.skuFind },
    localVideoCategory: { findUniqueOrThrow: mocks.categoryFind },
    localVideoMaterial: { create: mocks.materialCreate, update: mocks.materialUpdate, findMany: mocks.materialFind, findUnique: mocks.materialGet },
} }));
vi.mock("../auto-video/engine.js", () => ({ uploadEngineFile: mocks.upload, removeEngineUpload: mocks.cleanup, forwardStream: vi.fn() }));
vi.mock("./semantic-routes.js", async () => { const { Router } = await import("express"); return { materialSemanticRouter: Router(), queueMaterialAnalysis: mocks.queueAnalysis }; });
vi.mock("undici", () => ({ request: mocks.upstream, Agent: class {}, FormData: class {} }));
import { localMaterialRouter } from "./routes.js";
import { autoVideoRouter } from "../auto-video/routes.js";

const sku = "10000000-0000-4000-8000-000000000001";
const category = "20000000-0000-4000-8000-000000000001";
const category2 = "20000000-0000-4000-8000-000000000002";
const material = "30000000-0000-4000-8000-000000000001";
function app(authenticated = true) {
    const api = express();
    api.use(express.json());
    api.use((req, _res, next) => {
        if (authenticated) req.user = { id: "member", mustChangePassword: false, role: "member" } as Express.Request["user"];
        next();
    });
    api.use("/library", localMaterialRouter);
    api.use("/auto", autoVideoRouter);
    api.use(((error, _req, res, _next) => res.status(error.status || (error.name === "ZodError" ? 400 : 500)).json({ error: error.message })) as ErrorRequestHandler);
    return api;
}
describe("共享本地视频素材库", () => {
    beforeEach(() => {
        vi.resetAllMocks();
        mocks.queueAnalysis.mockResolvedValue({});
        mocks.materialGet.mockResolvedValue(null);
        mocks.upload.mockResolvedValue("immutable.mp4");
        mocks.cleanup.mockResolvedValue(undefined);
        mocks.skuFind.mockResolvedValue({ id: sku, name: "ABC-001" });
        mocks.categoryFind.mockResolvedValue({ id: category });
        mocks.upstream.mockResolvedValue({ statusCode: 200, body: { text: async () => '{"data":{"task_id":"task"},"status":200}' } });
    });
    it("未登录不能访问素材或剪辑方案", async () => {
        expect((await request(app(false)).get("/library/skus")).status).toBe(401);
        expect((await request(app(false)).get("/auto/plans")).status).toBe(401);
        expect(mocks.materialFind).not.toHaveBeenCalled();
    });
    it("普通成员可创建货号，去空格保留显示名称并生成大小写无关唯一键", async () => {
        mocks.skuCreate.mockResolvedValue({ id: sku, name: "AbC" });
        expect((await request(app()).post("/library/skus").send({ name: " AbC " })).status).toBe(201);
        expect(mocks.skuCreate).toHaveBeenCalledWith({ data: { name: "AbC", nameKey: "abc" } });
        mocks.skuCreate.mockRejectedValue({ code: "P2002" });
        expect((await request(app()).post("/library/skus").send({ name: "abc" })).status).toBe(409);
    });
    it("缺少归类和图片上传在请求引擎前被拒绝", async () => {
        expect((await request(app()).post("/library/upload").attach("file", Buffer.from("video"), "clip.mp4")).status).toBe(400);
        expect((await request(app()).post("/library/upload").field("skuId", sku).field("categoryId", category).attach("file", Buffer.from("image"), "photo.png")).status).toBe(400);
        expect(mocks.upload).not.toHaveBeenCalled();
    });
    it.each(["视频.mp4", "货号ABC-001 产品展示（正面）.MP4", "新品🎬.mov", "clip.mp4"])("上传 %s 时引擎和数据库收到原始文件名", async (fileName) => {
        mocks.materialCreate.mockResolvedValue({ id: material, fileName, fileKey: "immutable.mp4" });
        const result = await request(app()).post("/library/upload")
            .field("skuId", sku).field("categoryId", category)
            .attach("file", Buffer.from("video"), fileName);
        expect(result.status).toBe(201);
        expect(mocks.upload).toHaveBeenCalledWith(expect.objectContaining({ originalname: fileName }), "ABC-001");
        expect(mocks.materialCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ fileName }) }));
        expect(result.body.fileName).toBe(fileName);
    });
    it("上传时备注随素材入库，超长备注被拒绝", async () => {
        mocks.materialCreate.mockResolvedValue({ id: material, fileName: "clip.mp4", fileKey: "immutable.mp4" });
        const result = await request(app()).post("/library/upload")
            .field("skuId", sku).field("categoryId", category).field("notes", "蓝色 防水款 XX-1")
            .attach("file", Buffer.from("video"), "clip.mp4");
        expect(result.status).toBe(201);
        expect(mocks.materialCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ notes: "蓝色 防水款 XX-1" }) }));
        expect((await request(app()).post("/library/upload")
            .field("skuId", sku).field("categoryId", category).field("notes", "长".repeat(501))
            .attach("file", Buffer.from("video"), "clip.mp4")).status).toBe(400);
    });
    it("引擎内容校验失败不会创建素材记录", async () => {
        mocks.upload.mockRejectedValue(Object.assign(new Error("视频内容无效"), { status: 400 }));
        expect((await request(app()).post("/library/upload").field("skuId", sku).field("categoryId", category).attach("file", Buffer.from("image"), "photo.mp4")).status).toBe(400);
        expect(mocks.materialCreate).not.toHaveBeenCalled();
    });
    it("元数据写入失败清理刚上传的文件", async () => {
        mocks.materialCreate.mockRejectedValue(new Error("database failure"));
        expect((await request(app()).post("/library/upload").field("skuId", sku).field("categoryId", category).attach("file", Buffer.from("video"), "clip.mp4")).status).toBe(500);
        expect(mocks.cleanup).toHaveBeenCalledWith("immutable.mp4");
    });
    it("删除仅解除归类并标记删除，不清理任务仍可能使用的视频", async () => {
        mocks.materialUpdate.mockResolvedValue({});
        expect((await request(app()).delete(`/library/${material}`)).status).toBe(200);
        expect(mocks.materialUpdate).toHaveBeenCalledWith({ where: { id: material, deletedAt: null }, data: { deletedAt: expect.any(Date), skuId: null, categoryId: null } });
        expect(mocks.cleanup).not.toHaveBeenCalled();
    });
    it("分析队列失败不删除上传成功文件", async () => {
        mocks.materialCreate.mockResolvedValue({ id: material, fileName: "中文.mp4", fileKey: "immutable.mp4" });
        mocks.queueAnalysis.mockRejectedValue(new Error("queue unavailable"));
        mocks.materialUpdate.mockResolvedValue({});
        expect((await request(app()).post("/library/upload").field("skuId",sku).field("categoryId",category).attach("file",Buffer.from("video"),"中文.mp4")).status).toBe(201);
        expect(mocks.cleanup).not.toHaveBeenCalled();
    });
});

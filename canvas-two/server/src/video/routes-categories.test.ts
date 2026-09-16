import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    requireReadyUser: vi.fn(),
    categoryFindUnique: vi.fn(),
    categoryCreate: vi.fn(),
    categoryUpdate: vi.fn(),
}));

vi.mock("../access.js", () => ({ requireReadyUser: mocks.requireReadyUser }));
vi.mock("../db.js", () => ({ prisma: { videoCategory: { findUnique: mocks.categoryFindUnique, create: mocks.categoryCreate, update: mocks.categoryUpdate } } }));

import videoCategoriesRouter from "./routes-categories.js";

const user = { id: "11111111-1111-4111-8111-111111111111", username: "tester", role: "member", mustChangePassword: false };
const categoryId = "22222222-2222-4222-8222-222222222222";
const generalCategoryId = "33333333-3333-4333-8333-333333333333";
const systemGeneral = { id: generalCategoryId, name: "通用", isSystem: true, sortOrder: 3, enabled: true, createdAt: new Date() };
const systemBra = { id: "44444444-4444-4444-8444-444444444444", name: "文胸", isSystem: true, sortOrder: 1, enabled: true, createdAt: new Date() };
const customCategory = { id: categoryId, name: "泳装", isSystem: false, sortOrder: 0, enabled: true, createdAt: new Date() };

function app() {
    const value = express();
    value.use(express.json());
    value.use((req, _res, next) => { (req as unknown as { user: typeof user }).user = user; next(); });
    value.use("/api/video", videoCategoriesRouter);
    value.use((error: { status?: number; name?: string; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error.status || (error.name === "ZodError" ? 400 : 500)).json({ error: error.message }));
    return value;
}

describe("video categories routes", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.requireReadyUser.mockImplementation((_req: express.Request, _res: express.Response, next: express.NextFunction) => next());
        mocks.categoryFindUnique.mockResolvedValue(null);
        mocks.categoryCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: categoryId, createdAt: new Date(), ...data }));
        mocks.categoryUpdate.mockImplementation(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({ ...customCategory, id: where.id, ...data }));
    });

    it("requires a logged-in ready user", async () => {
        mocks.requireReadyUser.mockImplementationOnce((_req: express.Request, _res: express.Response, next: express.NextFunction) => next(Object.assign(new Error("请先登录"), { status: 401 })));
        const response = await request(app()).get("/api/video/categories");
        expect(response.status).toBe(401);
        expect(mocks.categoryFindUnique).not.toHaveBeenCalled();
    });

    it("creates a custom category with enabled=true", async () => {
        const response = await request(app()).post("/api/video/categories").send({ name: "  泳装  " });
        expect(response.status).toBe(201);
        expect(response.body.category).toEqual({ id: categoryId, name: "泳装", isSystem: false, sortOrder: 0, enabled: true });
        expect(mocks.categoryCreate).toHaveBeenCalledWith({ data: { name: "泳装", isSystem: false, sortOrder: 0, enabled: true } });
    });

    it("rejects creating 通用 and duplicate names (including disabled ones)", async () => {
        const general = await request(app()).post("/api/video/categories").send({ name: "通用" });
        expect(general.status).toBe(400);
        expect(general.body.error).toContain("系统分类");
        expect(mocks.categoryCreate).not.toHaveBeenCalled();
        mocks.categoryFindUnique.mockResolvedValueOnce({ ...customCategory, name: "泳装", enabled: false });
        const duplicate = await request(app()).post("/api/video/categories").send({ name: "泳装" });
        expect(duplicate.status).toBe(400);
        expect(duplicate.body.error).toContain("分类已存在");
        expect(mocks.categoryCreate).not.toHaveBeenCalled();
    });

    it("validates the category name", async () => {
        const empty = await request(app()).post("/api/video/categories").send({ name: "   " });
        expect(empty.status).toBe(400);
        expect(empty.body.error).toContain("请填写分类名");
        const tooLong = await request(app()).post("/api/video/categories").send({ name: "类".repeat(31) });
        expect(tooLong.status).toBe(400);
        expect(tooLong.body.error).toContain("30");
        expect(mocks.categoryCreate).not.toHaveBeenCalled();
    });

    it("renames a custom category after the uniqueness check", async () => {
        mocks.categoryFindUnique
            .mockResolvedValueOnce(customCategory)
            .mockResolvedValueOnce(null);
        const response = await request(app()).put(`/api/video/categories/${categoryId}`).send({ name: "家居服" });
        expect(response.status).toBe(200);
        expect(response.body.category).toEqual(expect.objectContaining({ id: categoryId, name: "家居服", enabled: true }));
        expect(mocks.categoryFindUnique).toHaveBeenNthCalledWith(1, { where: { id: categoryId } });
        expect(mocks.categoryFindUnique).toHaveBeenNthCalledWith(2, { where: { name: "家居服" } });
        expect(mocks.categoryUpdate).toHaveBeenCalledWith({ where: { id: categoryId }, data: { name: "家居服" } });
    });

    it("keeps its own name without tripping the uniqueness check", async () => {
        mocks.categoryFindUnique.mockResolvedValueOnce(customCategory);
        const response = await request(app()).put(`/api/video/categories/${categoryId}`).send({ name: "泳装" });
        expect(response.status).toBe(200);
        expect(mocks.categoryFindUnique).toHaveBeenCalledTimes(1);
        expect(mocks.categoryUpdate).toHaveBeenCalledWith({ where: { id: categoryId }, data: { name: "泳装" } });
    });

    it("toggles enabled on a custom category", async () => {
        mocks.categoryFindUnique.mockResolvedValueOnce(customCategory);
        const response = await request(app()).put(`/api/video/categories/${categoryId}`).send({ enabled: false });
        expect(response.status).toBe(200);
        expect(response.body.category).toEqual(expect.objectContaining({ id: categoryId, enabled: false }));
        expect(mocks.categoryUpdate).toHaveBeenCalledWith({ where: { id: categoryId }, data: { enabled: false } });
    });

    it("protects system categories from updates", async () => {
        mocks.categoryFindUnique.mockResolvedValueOnce(systemBra);
        const response = await request(app()).put(`/api/video/categories/${systemBra.id}`).send({ name: "新品" });
        expect(response.status).toBe(400);
        expect(response.body.error).toContain("系统分类不可修改");
        expect(mocks.categoryUpdate).not.toHaveBeenCalled();
    });

    it("returns 404 for an unknown category and rejects empty update bodies", async () => {
        const unknown = await request(app()).put(`/api/video/categories/${categoryId}`).send({ name: "新品" });
        expect(unknown.status).toBe(404);
        expect(unknown.body.error).toContain("分类不存在");
        // 空 body 在 zod 层就失败，不会查库
        const empty = await request(app()).put(`/api/video/categories/${categoryId}`).send({});
        expect(empty.status).toBe(400);
        expect(empty.body.error).toContain("至少传入一个要更新的字段");
        expect(mocks.categoryUpdate).not.toHaveBeenCalled();
    });

    it("soft-deletes a custom category by disabling it", async () => {
        mocks.categoryFindUnique.mockResolvedValueOnce(customCategory);
        const response = await request(app()).delete(`/api/video/categories/${categoryId}`);
        expect(response.status).toBe(200);
        expect(response.body.category).toEqual(expect.objectContaining({ id: categoryId, name: "泳装", enabled: false }));
        expect(mocks.categoryUpdate).toHaveBeenCalledWith({ where: { id: categoryId }, data: { enabled: false } });
    });

    it("is idempotent when deleting an already-disabled category", async () => {
        mocks.categoryFindUnique.mockResolvedValueOnce({ ...customCategory, enabled: false });
        const response = await request(app()).delete(`/api/video/categories/${categoryId}`);
        expect(response.status).toBe(200);
        expect(response.body.category).toEqual(expect.objectContaining({ id: categoryId, enabled: false }));
        expect(mocks.categoryUpdate).not.toHaveBeenCalled();
    });

    it("protects system categories from deletion", async () => {
        mocks.categoryFindUnique.mockResolvedValueOnce(systemGeneral);
        const response = await request(app()).delete(`/api/video/categories/${generalCategoryId}`);
        expect(response.status).toBe(400);
        expect(response.body.error).toContain("系统分类不可删除");
        expect(mocks.categoryUpdate).not.toHaveBeenCalled();
    });

    it("returns 404 when deleting an unknown category", async () => {
        const response = await request(app()).delete(`/api/video/categories/${categoryId}`);
        expect(response.status).toBe(404);
        expect(response.body.error).toContain("分类不存在");
    });
});

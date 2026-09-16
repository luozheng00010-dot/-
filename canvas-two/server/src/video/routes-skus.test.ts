import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    requireReadyUser: vi.fn(),
    skuFindMany: vi.fn(),
    skuFindUnique: vi.fn(),
    skuCreate: vi.fn(),
    skuDelete: vi.fn(),
    materialGroupBy: vi.fn(),
    materialCount: vi.fn(),
}));

vi.mock("../access.js", () => ({ requireReadyUser: mocks.requireReadyUser }));
vi.mock("../db.js", () => ({ prisma: {
    videoSku: { findMany: mocks.skuFindMany, findUnique: mocks.skuFindUnique, create: mocks.skuCreate, delete: mocks.skuDelete },
    videoMaterial: { groupBy: mocks.materialGroupBy, count: mocks.materialCount },
} }));

import videoSkusRouter from "./routes-skus.js";

const user = { id: "11111111-1111-4111-8111-111111111111", username: "tester", role: "member", mustChangePassword: false };
const skuId = "22222222-2222-4222-8222-222222222222";

function skuRow(overrides: Record<string, unknown> = {}) {
    return { id: skuId, name: "A123", createdAt: new Date("2026-09-01T00:00:00Z"), ...overrides };
}

function app() {
    const value = express();
    value.use(express.json());
    value.use((req, _res, next) => { (req as unknown as { user: typeof user }).user = user; next(); });
    value.use("/api/video", videoSkusRouter);
    value.use((error: { status?: number; name?: string; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error.status || (error.name === "ZodError" ? 400 : 500)).json({ error: error.message }));
    return value;
}

describe("video skus routes", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.requireReadyUser.mockImplementation((_req: express.Request, _res: express.Response, next: express.NextFunction) => next());
        mocks.skuFindMany.mockResolvedValue([]);
        mocks.skuFindUnique.mockResolvedValue(null);
        mocks.skuCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: skuId, createdAt: new Date("2026-09-02T00:00:00Z"), ...data }));
        mocks.skuDelete.mockResolvedValue(skuRow());
        mocks.materialGroupBy.mockResolvedValue([]);
        mocks.materialCount.mockResolvedValue(0);
    });

    it("requires a logged-in ready user", async () => {
        mocks.requireReadyUser.mockImplementationOnce((_req: express.Request, _res: express.Response, next: express.NextFunction) => next(Object.assign(new Error("请先登录"), { status: 401 })));
        const response = await request(app()).get("/api/video/skus");
        expect(response.status).toBe(401);
        expect(mocks.skuFindMany).not.toHaveBeenCalled();
    });

    it("lists skus with active material counts ordered by createdAt desc", async () => {
        const older = skuRow({ id: "sku-old", name: "B456", createdAt: new Date("2026-08-01T00:00:00Z") });
        const newer = skuRow({ id: "sku-new", name: "C789", createdAt: new Date("2026-09-01T00:00:00Z") });
        // 数据库按 createdAt desc 返回，B456 已全部归档故不出现
        mocks.skuFindMany.mockResolvedValue([newer, older]);
        mocks.materialGroupBy.mockResolvedValue([
            { sku: "C789", _count: { _all: 3 } },
        ]);
        const response = await request(app()).get("/api/video/skus");
        expect(response.status).toBe(200);
        expect(mocks.skuFindMany).toHaveBeenCalledWith({ orderBy: { createdAt: "desc" } });
        expect(mocks.materialGroupBy).toHaveBeenCalledWith({ by: ["sku"], where: { status: { not: "archived" } }, _count: { _all: true } });
        expect(response.body.skus).toEqual([
            { id: "sku-new", name: "C789", materialCount: 3, createdAt: newer.createdAt.toISOString() },
            { id: "sku-old", name: "B456", materialCount: 0, createdAt: older.createdAt.toISOString() },
        ]);
    });

    it("creates a sku after trimming the name", async () => {
        const response = await request(app()).post("/api/video/skus").send({ name: "  A123  " });
        expect(response.status).toBe(201);
        expect(response.body.sku).toEqual({ id: skuId, name: "A123", materialCount: 0, createdAt: "2026-09-02T00:00:00.000Z" });
        expect(mocks.skuCreate).toHaveBeenCalledWith({ data: { name: "A123" } });
    });

    it("rejects a duplicate sku name", async () => {
        mocks.skuFindUnique.mockResolvedValue(skuRow());
        const response = await request(app()).post("/api/video/skus").send({ name: "A123" });
        expect(response.status).toBe(400);
        expect(response.body.error).toContain("货号已存在");
        expect(mocks.skuCreate).not.toHaveBeenCalled();
    });

    it("rejects the reserved 通用 sentinel name", async () => {
        const response = await request(app()).post("/api/video/skus").send({ name: "通用" });
        expect(response.status).toBe(400);
        expect(response.body.error).toContain("通用为系统保留");
        expect(mocks.skuCreate).not.toHaveBeenCalled();
    });

    it("rejects an empty or too-long name", async () => {
        const empty = await request(app()).post("/api/video/skus").send({ name: "   " });
        expect(empty.status).toBe(400);
        expect(empty.body.error).toContain("请填写货号");
        const long = await request(app()).post("/api/video/skus").send({ name: "x".repeat(101) });
        expect(long.status).toBe(400);
        expect(long.body.error).toContain("100");
        expect(mocks.skuCreate).not.toHaveBeenCalled();
    });

    it("refuses to delete a sku that still has materials (archived included)", async () => {
        mocks.skuFindUnique.mockResolvedValue(skuRow());
        mocks.materialCount.mockResolvedValue(5);
        const response = await request(app()).delete(`/api/video/skus/${skuId}`);
        expect(response.status).toBe(400);
        expect(response.body.error).toBe("该货号下还有 5 条视频素材，无法删除");
        expect(mocks.materialCount).toHaveBeenCalledWith({ where: { sku: "A123" } });
        expect(mocks.skuDelete).not.toHaveBeenCalled();
    });

    it("deletes a sku without materials", async () => {
        mocks.skuFindUnique.mockResolvedValue(skuRow());
        const response = await request(app()).delete(`/api/video/skus/${skuId}`);
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ ok: true });
        expect(mocks.skuDelete).toHaveBeenCalledWith({ where: { id: skuId } });
    });

    it("returns 404 for an unknown sku", async () => {
        const response = await request(app()).delete(`/api/video/skus/${skuId}`);
        expect(response.status).toBe(404);
        expect(response.body.error).toContain("货号不存在");
        expect(mocks.skuDelete).not.toHaveBeenCalled();
    });
});

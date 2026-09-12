import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    assertAccess: vi.fn(), accessibleOwnerIds: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), findMany: vi.fn(), count: vi.fn(), create: vi.fn(), updateMany: vi.fn(), channelFindUnique: vi.fn(), canvasFindUniqueOrThrow: vi.fn(), mediaFindUniqueOrThrow: vi.fn(), mediaFindMany: vi.fn(),
}));

vi.mock("./access.js", () => ({
    assertAccess: mocks.assertAccess,
    accessibleOwnerIds: mocks.accessibleOwnerIds,
    requireReadyUser: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));
vi.mock("./db.js", () => ({ prisma: {
    imageGenerationTask: { findUnique: mocks.findUnique, findUniqueOrThrow: mocks.findUniqueOrThrow, findMany: mocks.findMany, count: mocks.count, create: mocks.create, updateMany: mocks.updateMany },
    modelChannel: { findUnique: mocks.channelFindUnique },
    canvasProject: { findUniqueOrThrow: mocks.canvasFindUniqueOrThrow },
    mediaFile: { findUniqueOrThrow: mocks.mediaFindUniqueOrThrow, findMany: mocks.mediaFindMany },
} }));
vi.mock("./media.js", () => ({ mediaResponse: (item: Record<string, unknown>) => ({ ...item, url: `/api/media/${item.id}/content`, thumbnailUrl: `/api/media/${item.id}/thumbnail` }) }));

import { imageTaskRouter } from "./image-tasks.js";

const user = { id: "11111111-1111-4111-8111-111111111111", username: "tester", usernameKey: "tester", passwordHash: "hash", role: "member", mustChangePassword: false, deletedAt: null, createdAt: new Date(), updatedAt: new Date() };
const ownerId = user.id;
const channelId = "22222222-2222-4222-8222-222222222222";
const taskId = "33333333-3333-4333-8333-333333333333";
const baseTask = {
    id: taskId, ownerId, createdById: ownerId, channelId, clientRequestId: "client-1", retryOfId: null, operation: "generation", model: "image-model", prompt: "测试图片", requestPrompt: "测试图片", parameters: {}, references: [], maskMediaId: null, context: null, status: "queued", completedCount: 0, totalCount: 2, results: [{ index: 0, status: "queued" }, { index: 1, status: "queued" }], error: null, createdAt: new Date(), updatedAt: new Date(), startedAt: null, completedAt: null,
};

function app() {
    const value = express();
    value.use(express.json());
    value.use((req, _res, next) => { (req as typeof req & { user: typeof user }).user = user; next(); });
    value.use("/api/image-generation-tasks", imageTaskRouter);
    value.use((error: { status?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error.status || 500).json({ error: error.message }));
    return value;
}

describe("image generation tasks", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.accessibleOwnerIds.mockResolvedValue([ownerId]);
        mocks.assertAccess.mockResolvedValue("edit");
        mocks.findUnique.mockResolvedValue(null);
        mocks.findMany.mockResolvedValue([]);
        mocks.canvasFindUniqueOrThrow.mockResolvedValue({ id: "55555555-5555-4555-8555-555555555555", ownerId });
        mocks.mediaFindMany.mockResolvedValue([]);
        mocks.count.mockResolvedValue(0);
        mocks.channelFindUnique.mockResolvedValue({ id: channelId, enabled: true, models: [{ name: "image-model", capability: "image", enabled: true }] });
    });

    it("returns the original task for a repeated clientRequestId", async () => {
        mocks.findUnique.mockResolvedValue(baseTask);
        const response = await request(app()).post("/api/image-generation-tasks").send({ clientRequestId: "client-1", channelId, operation: "generation", model: "image-model", prompt: "测试图片", requestPrompt: "测试图片", count: 2, parameters: {} });
        expect(response.status).toBe(200);
        expect(response.body.task.id).toBe(taskId);
        expect(mocks.create).not.toHaveBeenCalled();
    });

    it("cancels a queued task and records a reason for every slot", async () => {
        mocks.findUniqueOrThrow.mockResolvedValueOnce(baseTask).mockResolvedValueOnce({ ...baseTask, status: "cancelled", error: "任务已取消", completedCount: 2, results: [{ index: 0, status: "failed", error: "任务已取消" }, { index: 1, status: "failed", error: "任务已取消" }] });
        mocks.updateMany.mockResolvedValue({ count: 1 });
        const response = await request(app()).post(`/api/image-generation-tasks/${taskId}/cancel`).send({});
        expect(response.status).toBe(200);
        expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "cancelled", completedCount: 2, results: expect.arrayContaining([expect.objectContaining({ status: "failed", error: "任务已取消" })]) }) }));
    });

    it("rejects cancellation after a task has started", async () => {
        mocks.findUniqueOrThrow.mockResolvedValue({ ...baseTask, status: "running" });
        const response = await request(app()).post(`/api/image-generation-tasks/${taskId}/cancel`).send({});
        expect(response.status).toBe(409);
        expect(response.body.error).toContain("无法取消");
        expect(mocks.updateMany).not.toHaveBeenCalled();
    });

    it("creates a new queued task when retrying a failed task", async () => {
        const failed = { ...baseTask, status: "failed", error: "上游限流" };
        const retried = { ...baseTask, id: "44444444-4444-4444-8444-444444444444", clientRequestId: "retry-1", retryOfId: taskId };
        mocks.findUniqueOrThrow.mockResolvedValue(failed);
        mocks.create.mockResolvedValue(retried);
        const response = await request(app()).post(`/api/image-generation-tasks/${taskId}/retry`).send({ clientRequestId: "retry-1" });
        expect(response.status).toBe(202);
        expect(response.body.task.retryOfId).toBe(taskId);
        expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ retryOfId: taskId }) }));
    });

    it("filters recovery queries by canvasId", async () => {
        const response = await request(app()).get("/api/image-generation-tasks?owner=all&canvasId=55555555-5555-4555-8555-555555555555");
        expect(response.status).toBe(200);
        expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                context: { path: ["canvasId"], equals: "55555555-5555-4555-8555-555555555555" },
            }),
        }));
    });

    it("checks canvas edit access before accepting a canvas task", async () => {
        mocks.findUnique.mockResolvedValue(baseTask);
        const canvasId = "55555555-5555-4555-8555-555555555555";
        const response = await request(app()).post("/api/image-generation-tasks").send({ clientRequestId: "client-1", channelId, operation: "generation", model: "image-model", prompt: "测试图片", requestPrompt: "测试图片", count: 2, parameters: {}, context: { canvasId, bindings: [{ nodeId: "node-1", slot: 0 }] } });
        expect(response.status).toBe(200);
        expect(mocks.canvasFindUniqueOrThrow).toHaveBeenCalledWith({ where: { id: canvasId } });
        expect(mocks.assertAccess).toHaveBeenCalledWith(user, ownerId, "edit");
    });
});

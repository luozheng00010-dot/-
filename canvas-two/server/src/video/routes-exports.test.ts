import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    requireReadyUser: vi.fn(),
    timelineFindUnique: vi.fn(),
    taskCreate: vi.fn(),
    taskFindMany: vi.fn(),
    taskFindUnique: vi.fn(),
    listBgmAssets: vi.fn(),
}));

vi.mock("../access.js", () => ({ requireReadyUser: mocks.requireReadyUser }));
vi.mock("../db.js", () => ({
    prisma: {
        videoTimeline: { findUnique: mocks.timelineFindUnique },
        videoExportTask: { create: mocks.taskCreate, findMany: mocks.taskFindMany, findUnique: mocks.taskFindUnique },
    },
}));
vi.mock("./export.js", () => ({ listBgmAssets: mocks.listBgmAssets }));

import videoExportsRouter from "./routes-exports.js";

const user = { id: "11111111-1111-4111-8111-111111111111", username: "tester", role: "member", mustChangePassword: false };
const timelineId = "22222222-2222-4222-8222-222222222222";
const taskId = "33333333-3333-4333-8333-333333333333";
const createdAt = new Date("2026-09-15T10:00:00Z");

function app() {
    const value = express();
    value.use(express.json());
    value.use((req, _res, next) => { (req as unknown as { user: typeof user }).user = user; next(); });
    value.use("/api/video", videoExportsRouter);
    value.use((error: { status?: number; name?: string; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error.status || (error.name === "ZodError" ? 400 : 500)).json({ error: error.message }));
    return value;
}

const taskRow = (overrides: Record<string, unknown> = {}) => ({
    id: taskId,
    timelineId,
    status: "queued",
    progress: 0,
    error: null,
    outputMediaId: null,
    createdAt,
    finishedAt: null,
    ...overrides,
});

describe("video export routes", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.requireReadyUser.mockImplementation((_req: express.Request, _res: express.Response, next: express.NextFunction) => next());
        mocks.timelineFindUnique.mockResolvedValue({ id: timelineId, status: "matched" });
        mocks.taskCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => taskRow({ ...data }));
        mocks.taskFindMany.mockResolvedValue([]);
        mocks.taskFindUnique.mockResolvedValue(null);
        mocks.listBgmAssets.mockReturnValue([{ id: "轻快日常", fileName: "轻快日常.mp3" }]);
    });

    it("requires a logged-in ready user", async () => {
        mocks.requireReadyUser.mockImplementationOnce((_req: express.Request, _res: express.Response, next: express.NextFunction) => next(Object.assign(new Error("请先登录"), { status: 401 })));
        const response = await request(app()).get("/api/video/exports");
        expect(response.status).toBe(401);
        expect(mocks.taskFindMany).not.toHaveBeenCalled();
    });

    it("creates a queued export task and answers 202 with the task summary", async () => {
        const response = await request(app()).post(`/api/video/timelines/${timelineId}/export`).send({});
        expect(response.status).toBe(202);
        expect(response.body.task).toEqual({
            id: taskId,
            timelineId,
            status: "queued",
            progress: 0,
            error: null,
            outputMediaId: null,
            createdAt: createdAt.toISOString(),
            finishedAt: null,
        });
        expect(mocks.taskCreate).toHaveBeenCalledWith({
            data: { timelineId, createdById: user.id, params: { resolution: "1080x1920", burnSubtitle: true, subtitleStyle: "minimal", bgm: null, bgmVolume: 0.15 }, status: "queued" },
        });
    });

    it("stores the explicit resolution into task params", async () => {
        const response = await request(app()).post(`/api/video/timelines/${timelineId}/export`).send({ resolution: "1080x1920" });
        expect(response.status).toBe(202);
        expect(mocks.taskCreate).toHaveBeenCalledWith({
            data: expect.objectContaining({ params: { resolution: "1080x1920", burnSubtitle: true, subtitleStyle: "minimal", bgm: null, bgmVolume: 0.15 } }),
        });
    });

    it("persists the P2 export options (burnSubtitle/subtitleStyle/bgm/bgmVolume)", async () => {
        const response = await request(app()).post(`/api/video/timelines/${timelineId}/export`).send({
            burnSubtitle: false,
            subtitleStyle: "bar",
            bgm: "轻快日常",
            bgmVolume: 0.3,
        });
        expect(response.status).toBe(202);
        expect(mocks.taskCreate).toHaveBeenCalledWith({
            data: expect.objectContaining({ params: { resolution: "1080x1920", burnSubtitle: false, subtitleStyle: "bar", bgm: "轻快日常", bgmVolume: 0.3 } }),
        });
    });

    it("accepts an explicit null bgm", async () => {
        const response = await request(app()).post(`/api/video/timelines/${timelineId}/export`).send({ bgm: null });
        expect(response.status).toBe(202);
        expect(mocks.taskCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ params: expect.objectContaining({ bgm: null }) }) });
    });

    it("rejects a bgm id that is not in the asset library with 400", async () => {
        const response = await request(app()).post(`/api/video/timelines/${timelineId}/export`).send({ bgm: "不存在的曲子" });
        expect(response.status).toBe(400);
        expect(response.body.error).toContain("BGM 不存在");
        expect(mocks.taskCreate).not.toHaveBeenCalled();
    });

    it("rejects invalid subtitle styles and bgm volumes with 400", async () => {
        const badStyle = await request(app()).post(`/api/video/timelines/${timelineId}/export`).send({ subtitleStyle: "fancy" });
        expect(badStyle.status).toBe(400);
        expect(badStyle.body.error).toContain("minimal");
        const loudVolume = await request(app()).post(`/api/video/timelines/${timelineId}/export`).send({ bgmVolume: 1.5 });
        expect(loudVolume.status).toBe(400);
        expect(loudVolume.body.error).toContain("BGM 音量不能大于 1");
        const badFlag = await request(app()).post(`/api/video/timelines/${timelineId}/export`).send({ burnSubtitle: "no" });
        expect(badFlag.status).toBe(400);
        expect(mocks.taskCreate).not.toHaveBeenCalled();
    });

    it("rejects unsupported resolutions with 400", async () => {
        const response = await request(app()).post(`/api/video/timelines/${timelineId}/export`).send({ resolution: "720x1280" });
        expect(response.status).toBe(400);
        expect(response.body.error).toContain("1080x1920");
        expect(mocks.taskCreate).not.toHaveBeenCalled();
    });

    it("returns 404 when the timeline does not exist", async () => {
        mocks.timelineFindUnique.mockResolvedValue(null);
        const response = await request(app()).post(`/api/video/timelines/${timelineId}/export`).send({});
        expect(response.status).toBe(404);
        expect(response.body.error).toContain("时间线不存在");
        expect(mocks.taskCreate).not.toHaveBeenCalled();
    });

    it("lists the latest 50 export tasks ordered by createdAt desc", async () => {
        mocks.taskFindMany.mockResolvedValue([taskRow({ status: "succeeded", progress: 100, outputMediaId: "media-1", finishedAt: new Date("2026-09-15T10:05:00Z") })]);
        const response = await request(app()).get("/api/video/exports");
        expect(response.status).toBe(200);
        expect(mocks.taskFindMany).toHaveBeenCalledWith({ orderBy: { createdAt: "desc" }, take: 50 });
        expect(response.body.tasks).toEqual([{
            id: taskId,
            timelineId,
            status: "succeeded",
            progress: 100,
            error: null,
            outputMediaId: "media-1",
            createdAt: createdAt.toISOString(),
            finishedAt: "2026-09-15T10:05:00.000Z",
        }]);
    });

    it("returns a single task by id", async () => {
        mocks.taskFindUnique.mockResolvedValue(taskRow({ status: "running", progress: 42 }));
        const response = await request(app()).get(`/api/video/exports/${taskId}`);
        expect(response.status).toBe(200);
        expect(mocks.taskFindUnique).toHaveBeenCalledWith({ where: { id: taskId } });
        expect(response.body.task).toEqual(expect.objectContaining({ id: taskId, status: "running", progress: 42 }));
    });

    it("returns 404 for an unknown task", async () => {
        const response = await request(app()).get(`/api/video/exports/${taskId}`);
        expect(response.status).toBe(404);
        expect(response.body.error).toContain("导出任务不存在");
    });
});

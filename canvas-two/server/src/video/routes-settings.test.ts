import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    requireReadyUser: vi.fn(),
    requireAdmin: vi.fn(),
    settingFindUnique: vi.fn(),
    settingUpsert: vi.fn(),
    channelFindUnique: vi.fn(),
    channelFindMany: vi.fn(),
}));

vi.mock("../access.js", () => ({ requireReadyUser: mocks.requireReadyUser, requireAdmin: mocks.requireAdmin }));
vi.mock("../db.js", () => {
    const prisma = {
        videoSetting: { findUnique: mocks.settingFindUnique, upsert: mocks.settingUpsert },
        modelChannel: { findUnique: mocks.channelFindUnique, findMany: mocks.channelFindMany },
    };
    return { prisma };
});

import videoSettingsRouter from "./routes-settings.js";

const channelId = "22222222-2222-4222-8222-222222222222";
const otherChannelId = "33333333-3333-4333-8333-333333333333";
const openaiChannel = { id: channelId, name: "主渠道", apiFormat: "openai", models: [{ id: "m1", name: "qwen-vl-max", capability: "image" }, { id: "m2", name: "qwen-plus", capability: "text" }] };
const geminiChannel = { id: otherChannelId, name: "Gemini 渠道", apiFormat: "gemini", models: [{ id: "m3", name: "gemini-2.0-flash", capability: "text" }] };

function app() {
    const value = express();
    value.use(express.json());
    value.use("/api/video", videoSettingsRouter);
    value.use((error: { status?: number; name?: string; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error.status || (error.name === "ZodError" ? 400 : 500)).json({ error: error.message }));
    return value;
}

describe("video settings routes", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.requireReadyUser.mockImplementation((_req: express.Request, _res: express.Response, next: express.NextFunction) => next());
        mocks.requireAdmin.mockImplementation((_req: express.Request, _res: express.Response, next: express.NextFunction) => next());
        mocks.settingFindUnique.mockResolvedValue(null);
        mocks.settingUpsert.mockResolvedValue({ id: "default", chatChannelId: null, chatModel: null, visionChannelId: null, visionModel: null });
        mocks.channelFindUnique.mockResolvedValue(null);
        mocks.channelFindMany.mockResolvedValue([]);
    });

    it("requires an admin user", async () => {
        mocks.requireAdmin.mockImplementationOnce((_req: express.Request, _res: express.Response, next: express.NextFunction) => next(Object.assign(new Error("需要管理员权限"), { status: 403 })));
        const response = await request(app()).get("/api/video/admin/settings");
        expect(response.status).toBe(403);
        expect(mocks.settingFindUnique).not.toHaveBeenCalled();
    });

    it("returns defaults and enabled models of non-gemini channels", async () => {
        mocks.channelFindMany.mockResolvedValue([openaiChannel, geminiChannel]);
        const response = await request(app()).get("/api/video/admin/settings");
        expect(response.status).toBe(200);
        expect(mocks.channelFindMany).toHaveBeenCalledWith({ where: { enabled: true }, include: { models: { where: { enabled: true }, orderBy: { name: "asc" } } }, orderBy: { name: "asc" } });
        expect(response.body).toEqual({
            settings: { chatChannelId: null, chatModel: null, visionChannelId: null, visionModel: null },
            channels: [{ id: channelId, name: "主渠道", apiFormat: "openai", models: ["qwen-vl-max", "qwen-plus"] }],
        });
    });

    it("returns the stored settings without extra columns", async () => {
        mocks.settingFindUnique.mockResolvedValue({ id: "default", chatChannelId: channelId, chatModel: "qwen-plus", visionChannelId: otherChannelId, visionModel: "gemini-2.0-flash" });
        const response = await request(app()).get("/api/video/admin/settings");
        expect(response.status).toBe(200);
        expect(response.body.settings).toEqual({ chatChannelId: channelId, chatModel: "qwen-plus", visionChannelId: otherChannelId, visionModel: "gemini-2.0-flash" });
    });

    it("rejects a chat channel that does not exist", async () => {
        const response = await request(app()).put("/api/video/admin/settings").send({ chatChannelId: channelId, chatModel: "qwen-plus" });
        expect(response.status).toBe(400);
        expect(response.body.error).toContain("所选渠道不存在");
        expect(mocks.settingUpsert).not.toHaveBeenCalled();
    });

    it("rejects a vision channel that does not exist", async () => {
        const response = await request(app()).put("/api/video/admin/settings").send({ visionChannelId: otherChannelId, visionModel: "qwen-vl-max" });
        expect(response.status).toBe(400);
        expect(response.body.error).toContain("所选渠道不存在");
        expect(mocks.settingUpsert).not.toHaveBeenCalled();
    });

    it("rejects a model that is not part of the channel", async () => {
        mocks.channelFindUnique.mockResolvedValue(openaiChannel);
        const response = await request(app()).put("/api/video/admin/settings").send({ chatChannelId: channelId, chatModel: "gpt-9" });
        expect(response.status).toBe(400);
        expect(response.body.error).toBe("渠道 主渠道 下不存在模型 gpt-9");
        expect(mocks.settingUpsert).not.toHaveBeenCalled();
    });

    it("upserts the default settings row and echoes the four fields", async () => {
        mocks.channelFindUnique.mockResolvedValueOnce(openaiChannel).mockResolvedValueOnce(geminiChannel);
        mocks.settingUpsert.mockResolvedValue({ id: "default", chatChannelId: channelId, chatModel: "qwen-plus", visionChannelId: otherChannelId, visionModel: "gemini-2.0-flash" });
        const response = await request(app()).put("/api/video/admin/settings").send({ chatChannelId: channelId, chatModel: "qwen-plus", visionChannelId: otherChannelId, visionModel: "gemini-2.0-flash" });
        expect(response.status).toBe(200);
        expect(mocks.settingUpsert).toHaveBeenCalledWith({
            where: { id: "default" },
            create: { id: "default", chatChannelId: channelId, chatModel: "qwen-plus", visionChannelId: otherChannelId, visionModel: "gemini-2.0-flash" },
            update: { chatChannelId: channelId, chatModel: "qwen-plus", visionChannelId: otherChannelId, visionModel: "gemini-2.0-flash" },
        });
        expect(response.body.settings).toEqual({ chatChannelId: channelId, chatModel: "qwen-plus", visionChannelId: otherChannelId, visionModel: "gemini-2.0-flash" });
    });

    it("allows clearing all fields back to null", async () => {
        const response = await request(app()).put("/api/video/admin/settings").send({ chatChannelId: null, chatModel: null, visionChannelId: null, visionModel: null });
        expect(response.status).toBe(200);
        expect(mocks.channelFindUnique).not.toHaveBeenCalled();
        expect(mocks.settingUpsert).toHaveBeenCalledWith(expect.objectContaining({ update: { chatChannelId: null, chatModel: null, visionChannelId: null, visionModel: null } }));
    });

    it("rejects invalid field shapes", async () => {
        const response = await request(app()).put("/api/video/admin/settings").send({ chatChannelId: "not-a-uuid" });
        expect(response.status).toBe(400);
        expect(mocks.settingUpsert).not.toHaveBeenCalled();
    });
});

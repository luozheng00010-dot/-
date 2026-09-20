import express, { type ErrorRequestHandler } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ settings: vi.fn(), save: vi.fn(), channels: vi.fn(), channel: vi.fn() }));
vi.mock("../db.js", () => ({ prisma: {
    autoVideoSetting: { findUnique: mocks.settings, upsert: mocks.save },
    modelChannel: { findMany: mocks.channels, findUnique: mocks.channel },
} }));
vi.mock("../security.js", () => ({ decryptSecret: () => "private-key", hashToken: vi.fn(), SESSION_COOKIE: "session" }));
vi.mock("./engine.js", () => ({ getEngineStorage: vi.fn(), setEngineStorage: vi.fn() }));
import { autoVideoSettingsRouter } from "./models.js";
import { getEngineStorage, setEngineStorage, type MaterialStorageSettings } from "./engine.js";

const channelId = "10000000-0000-4000-8000-000000000001";
const channel = { id: channelId, name: "文字渠道", apiFormat: "openai", baseUrl: "https://models.example/v1", apiKeyEncrypted: "encrypted", enabled: true,
    models: [{ name: "text-model", capability: "text", enabled: true }] };
function app(role: string) {
    const api = express();
    api.use(express.json());
    api.use((req, _res, next) => { if (role) req.user = { role, mustChangePassword: false } as Express.Request["user"]; next(); });
    api.use("/settings", autoVideoSettingsRouter);
    api.use(((error, _req, res, _next) => res.status(error.status || (error.name === "ZodError" ? 400 : 500)).json({ error: error.message })) as ErrorRequestHandler);
    return api;
}

describe("自动剪辑模型配置", () => {
    beforeEach(() => {
        vi.resetAllMocks();
        mocks.settings.mockResolvedValue({ channelId, model: "text-model" });
        mocks.channel.mockResolvedValue(channel);
        mocks.channels.mockResolvedValue([{ id: channelId, name: channel.name, apiFormat: "openai", models: [{ name: "text-model" }] }]);
        mocks.save.mockResolvedValue({ channelId, model: "text-model" });
        vi.mocked(getEngineStorage).mockResolvedValue(null as unknown as MaterialStorageSettings);
    });
    it("未登录和普通成员不能读取或修改全局配置", async () => {
        for (const [role, status] of [["", 401], ["member", 403]] as const) {
            expect((await request(app(role)).get("/settings")).status).toBe(status);
            expect((await request(app(role)).put("/settings").send({ channelId, model: "text-model" })).status).toBe(status);
        }
        expect(mocks.save).not.toHaveBeenCalled();
    });
    it("管理员可以保存配置，渠道查询不读取密钥", async () => {
        expect((await request(app("admin")).put("/settings").send({ channelId, model: "text-model" })).status).toBe(200);
        const result = await request(app("admin")).get("/settings");
        expect(result.body.channels[0]).toEqual({ id: channelId, name: channel.name, apiFormat: "openai", models: ["text-model"] });
        expect(mocks.channels.mock.calls[0][0].select).not.toHaveProperty("apiKeyEncrypted");
    });
    it("读取配置时以引擎返回的素材存储位置为准", async () => {
        vi.mocked(getEngineStorage).mockResolvedValue({ dir: "D:\\videos", default_dir: "C:\\default", custom: true });
        const result = await request(app("admin")).get("/settings");
        expect(result.status).toBe(200);
        expect(result.body.settings.storageDir).toBe("D:\\videos");
        expect(result.body.settings.storageDefaultDir).toBe("C:\\default");
    });
    it("保存配置时先下发引擎存储位置，成功后才落库", async () => {
        vi.mocked(setEngineStorage).mockResolvedValue({ dir: "D:\\videos", default_dir: "C:\\default", custom: true });
        mocks.save.mockResolvedValue({ channelId, model: "text-model", storageDir: "D:\\videos" });
        const result = await request(app("admin")).put("/settings").send({ channelId, model: "text-model", storageDir: "D:\\videos" });
        expect(result.status).toBe(200);
        expect(setEngineStorage).toHaveBeenCalledWith("D:\\videos");
        expect(mocks.save.mock.calls[0][0].update.storageDir).toBe("D:\\videos");
    });
    it("引擎拒绝存储位置时不写数据库", async () => {
        vi.mocked(setEngineStorage).mockRejectedValue(Object.assign(new Error("素材存储位置必须是绝对路径"), { status: 400 }));
        const result = await request(app("admin")).put("/settings").send({ channelId, model: "text-model", storageDir: "relative/path" });
        expect(result.status).toBe(400);
        expect(mocks.save).not.toHaveBeenCalled();
    });
    it.each([
        null, { ...channel, enabled: false }, { ...channel, apiFormat: "gemini" },
        { ...channel, models: [{ name: "text-model", capability: "image", enabled: true }] },
        { ...channel, models: [{ name: "text-model", capability: "text", enabled: false }] },
    ])("拒绝不存在、停用或非文字渠道与模型", async (value) => {
        mocks.channel.mockResolvedValue(value);
        expect((await request(app("admin")).put("/settings").send({ channelId, model: "text-model" })).status).toBe(400);
        expect(mocks.save).not.toHaveBeenCalled();
    });
});

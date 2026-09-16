import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { encryptSecret } from "../security.js";

const { findUniqueSetting, findUniqueChannel, findManyChannels } = vi.hoisted(() => ({ findUniqueSetting: vi.fn(), findUniqueChannel: vi.fn(), findManyChannels: vi.fn() }));
vi.mock("../db.js", () => ({ prisma: { videoSetting: { findUnique: findUniqueSetting }, modelChannel: { findUnique: findUniqueChannel, findMany: findManyChannels } } }));

import { chatJson, visionJson } from "./llm.js";

function channel(models: { name: string; capability?: string }[], overrides: Record<string, unknown> = {}) {
    return {
        id: "ch-1",
        name: "测试渠道",
        baseUrl: "https://llm.example.com/v1",
        apiFormat: "openai",
        apiKeyEncrypted: encryptSecret("sk-test"),
        enabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        models: models.map((model, index) => ({ id: `m-${index}`, channelId: "ch-1", name: model.name, capability: model.capability || "text", enabled: true })),
        ...overrides,
    };
}

const jsonResponse = (payload: unknown) => ({ ok: true, status: 200, statusText: "OK", text: async () => JSON.stringify(payload) });
const completion = (content: string) => ({ choices: [{ message: { content } }] });

const fetchMock = vi.fn();

describe("video llm structured output", () => {
    beforeEach(() => {
        vi.resetAllMocks();
        vi.stubGlobal("fetch", fetchMock);
        findUniqueSetting.mockResolvedValue(null);
        findManyChannels.mockResolvedValue([channel([{ name: "deepseek-chat" }])]);
    });
    afterEach(() => vi.unstubAllGlobals());

    const schema = z.object({ title: z.string(), seconds: z.number() });

    it("retries once with the validation error appended and succeeds on the second attempt", async () => {
        fetchMock
            .mockResolvedValueOnce(jsonResponse(completion(JSON.stringify({ seconds: 3 }))))
            .mockResolvedValueOnce(jsonResponse(completion(JSON.stringify({ title: "无钢圈文胸", seconds: 3 }))));
        await expect(chatJson("你是分镜师", "拆这段文案", schema)).resolves.toEqual({ title: "无钢圈文胸", seconds: 3 });
        expect(fetchMock).toHaveBeenCalledTimes(2);
        const firstBody = JSON.parse(fetchMock.mock.calls[0][1].body);
        const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body);
        expect(firstBody.messages[1].content).toBe("拆这段文案");
        expect(secondBody.messages[1].content).toContain("title: Required");
        expect(secondBody.response_format).toEqual({ type: "json_object" });
        expect(secondBody.model).toBe("deepseek-chat");
    });

    it("treats non-JSON output as a validation failure and retries", async () => {
        fetchMock
            .mockResolvedValueOnce(jsonResponse(completion("这不是 JSON")))
            .mockResolvedValueOnce(jsonResponse(completion(JSON.stringify({ title: "平角内裤", seconds: 2 }))));
        await expect(chatJson("你是分镜师", "拆这段文案", schema)).resolves.toEqual({ title: "平角内裤", seconds: 2 });
        const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body);
        expect(secondBody.messages[1].content).toContain("输出不是合法的 JSON");
    });

    it("throws VideoLlmError containing the upstream snippet when the retry also fails", async () => {
        fetchMock
            .mockResolvedValueOnce(jsonResponse(completion(JSON.stringify({ seconds: 3 }))))
            .mockResolvedValueOnce(jsonResponse(completion(JSON.stringify({ seconds: 4 }))));
        await expect(chatJson("你是分镜师", "拆这段文案", schema)).rejects.toThrow(/未通过校验[\s\S]*上游返回片段/);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("sends image_url multimodal content and retries with the error text", async () => {
        findManyChannels.mockResolvedValue([channel([{ name: "qwen-vl-max" }])]);
        const visionSchema = z.object({ category: z.string(), productVisible: z.boolean() });
        fetchMock
            .mockResolvedValueOnce(jsonResponse(completion(JSON.stringify({ category: "文胸" }))))
            .mockResolvedValueOnce(jsonResponse(completion(JSON.stringify({ category: "文胸", productVisible: true }))));
        const dataUrl = "data:image/jpeg;base64,aGVsbG8=";
        await expect(visionJson(dataUrl, "看图打标", visionSchema)).resolves.toEqual({ category: "文胸", productVisible: true });
        expect(fetchMock).toHaveBeenCalledTimes(2);
        const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body);
        expect(secondBody.model).toBe("qwen-vl-max");
        expect(secondBody.response_format).toEqual({ type: "json_object" });
        const parts = secondBody.messages[0].content;
        expect(parts[0].type).toBe("text");
        expect(parts[0].text).toContain("productVisible: Required");
        expect(parts[1]).toEqual({ type: "image_url", image_url: { url: dataUrl } });
    });

    it("rejects with a clear message when no vision model channel is available", async () => {
        findManyChannels.mockResolvedValue([channel([{ name: "deepseek-chat" }])]);
        await expect(visionJson("data:image/jpeg;base64,aGVsbG8=", "看图打标", z.object({ ok: z.boolean() }))).rejects.toThrow("未找到可用的视觉模型渠道，请管理员配置");
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects when the configured channel is disabled or gemini-format", async () => {
        findUniqueSetting.mockResolvedValue({ id: "default", chatChannelId: "ch-1", chatModel: "deepseek-chat", visionChannelId: null, visionModel: null });
        findUniqueChannel.mockResolvedValueOnce(channel([], { enabled: false }));
        await expect(chatJson("s", "u", z.object({ ok: z.boolean() }))).rejects.toThrow("已失效");
        findUniqueChannel.mockResolvedValueOnce(channel([], { apiFormat: "gemini" }));
        await expect(chatJson("s", "u", z.object({ ok: z.boolean() }))).rejects.toThrow("Gemini");
    });
});

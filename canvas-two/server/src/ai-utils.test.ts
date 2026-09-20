import { describe, expect, it } from "vitest";
import { mergeUpstreamUrl, safeUpstreamError } from "./ai-utils.js";

describe("AI upstream URLs", () => {
    it("does not duplicate OpenAI-compatible version prefixes", () => {
        expect(mergeUpstreamUrl("https://example.com/v1", "/v1/images/generations").toString()).toBe("https://example.com/v1/images/generations");
        expect(mergeUpstreamUrl("https://example.com/api/plan/v3", "/api/plan/v3/images/generations").toString()).toBe("https://example.com/api/plan/v3/images/generations");
    });
    it("智谱 base 带 /v4 时剥掉 suffix 的 /v1 版本段", () => {
        expect(mergeUpstreamUrl("https://open.bigmodel.cn/api/paas/v4", "/v1/embeddings").toString()).toBe("https://open.bigmodel.cn/api/paas/v4/embeddings");
        expect(mergeUpstreamUrl("https://open.bigmodel.cn/api/paas/v4", "/v1/chat/completions").toString()).toBe("https://open.bigmodel.cn/api/paas/v4/chat/completions");
    });

    it("removes API keys from upstream error details", () => {
        expect(safeUpstreamError({ error: { message: "invalid sk-secret" } }, "", 401, "sk-secret", "请求失败")).not.toContain("sk-secret");
    });
});

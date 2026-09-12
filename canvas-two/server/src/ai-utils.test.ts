import { describe, expect, it } from "vitest";
import { mergeUpstreamUrl, safeUpstreamError } from "./ai-utils.js";

describe("AI upstream URLs", () => {
    it("does not duplicate OpenAI-compatible version prefixes", () => {
        expect(mergeUpstreamUrl("https://example.com/v1", "/v1/images/generations").toString()).toBe("https://example.com/v1/images/generations");
        expect(mergeUpstreamUrl("https://example.com/api/plan/v3", "/api/plan/v3/images/generations").toString()).toBe("https://example.com/api/plan/v3/images/generations");
    });

    it("removes API keys from upstream error details", () => {
        expect(safeUpstreamError({ error: { message: "invalid sk-secret" } }, "", 401, "sk-secret", "请求失败")).not.toContain("sk-secret");
    });
});

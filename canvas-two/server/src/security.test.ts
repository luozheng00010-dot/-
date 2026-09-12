import { describe, expect, it } from "vitest";
import { assertPassword, assertUsername, decryptSecret, encryptSecret, hashPassword, normalizeUsername, verifyPassword } from "./security.js";

describe("account validation", () => {
    it("accepts Chinese and English names up to ten characters", () => {
        expect(assertUsername("张三")).toBe("张三");
        expect(assertUsername("root")).toBe("root");
        expect(assertUsername("设计Team")).toBe("设计Team");
    });
    it("rejects numbers, spaces and long names", () => {
        expect(() => assertUsername("user1")).toThrow();
        expect(() => assertUsername("张 三")).toThrow();
        expect(() => assertUsername("abcdefghijk")).toThrow();
    });
    it("normalizes English account names case-insensitively", () => expect(normalizeUsername("Root")).toBe("root"));
    it("requires normal passwords to contain 8-72 characters", () => {
        expect(() => assertPassword("short")).toThrow();
        expect(assertPassword("password123")).toBe("password123");
    });
});

describe("secrets", () => {
    it("hashes passwords with argon2id", async () => { const hash = await hashPassword("password123"); expect(await verifyPassword(hash, "password123")).toBe(true); expect(await verifyPassword(hash, "wrong")).toBe(false); });
    it("encrypts and decrypts channel keys", () => { const encrypted = encryptSecret("secret-key"); expect(encrypted).not.toContain("secret-key"); expect(decryptSecret(encrypted)).toBe("secret-key"); });
});

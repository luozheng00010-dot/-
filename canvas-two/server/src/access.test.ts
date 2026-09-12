import { beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "@prisma/client";

const { findUnique, findManyPermissions, findManyUsers } = vi.hoisted(() => ({ findUnique: vi.fn(), findManyPermissions: vi.fn(), findManyUsers: vi.fn() }));
vi.mock("./db.js", () => ({ prisma: { memberPermission: { findUnique, findMany: findManyPermissions }, user: { findMany: findManyUsers } } }));

import { accessLevel, accessibleOwnerIds, assertAccess } from "./access.js";

function user(values: Partial<User> = {}): User {
    return { id: "user-a", username: "甲", usernameKey: "甲", passwordHash: "hash", role: "member", mustChangePassword: false, deletedAt: null, createdAt: new Date(), updatedAt: new Date(), ...values };
}

describe("member access", () => {
    beforeEach(() => vi.clearAllMocks());
    it("grants edit access to self and every owner to admin", async () => {
        expect(await accessLevel(user(), "user-a")).toBe("edit");
        expect(await accessLevel(user({ role: "admin" }), "user-b")).toBe("edit");
    });
    it("honors explicit view and edit grants", async () => {
        findUnique.mockResolvedValueOnce({ level: "view", target: { deletedAt: null } }).mockResolvedValueOnce({ level: "edit", target: { deletedAt: null } });
        expect(await accessLevel(user(), "user-b")).toBe("view");
        expect(await accessLevel(user(), "user-b")).toBe("edit");
    });
    it("rejects edits through a view-only grant", async () => {
        findUnique.mockResolvedValue({ level: "view", target: { deletedAt: null } });
        await expect(assertAccess(user(), "user-b", "edit")).rejects.toMatchObject({ status: 403 });
    });
    it("builds the all-owner scope from active grants", async () => {
        findManyPermissions.mockResolvedValue([{ targetId: "user-b" }, { targetId: "user-c" }]);
        expect(await accessibleOwnerIds(user(), "all")).toEqual(["user-a", "user-b", "user-c"]);
    });
});

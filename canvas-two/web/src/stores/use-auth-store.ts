import { create } from "zustand";
import { serverApi } from "@/services/server-api";

export type SessionUser = { id: string; username: string; role: "admin" | "member"; mustChangePassword: boolean };

type AuthStore = {
    user: SessionUser | null;
    loading: boolean;
    initialized: boolean;
    loadSession: () => Promise<void>;
    login: (username: string, password: string) => Promise<SessionUser>;
    logout: () => Promise<void>;
    changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
};

export const useAuthStore = create<AuthStore>((set) => ({
    user: null,
    loading: false,
    initialized: false,
    loadSession: async () => {
        set({ loading: true });
        try {
            const { user } = await serverApi<{ user: SessionUser }>("/api/auth/me");
            set({ user, initialized: true, loading: false });
        } catch {
            set({ user: null, initialized: true, loading: false });
        }
    },
    login: async (username, password) => {
        set({ loading: true });
        try {
            const { user } = await serverApi<{ user: SessionUser }>("/api/auth/login", { method: "POST", body: JSON.stringify({ username, password }) });
            set({ user, initialized: true, loading: false });
            return user;
        } catch (error) {
            set({ loading: false });
            throw error;
        }
    },
    logout: async () => {
        await serverApi("/api/auth/logout", { method: "POST" }).catch(() => undefined);
        set({ user: null, initialized: true });
    },
    changePassword: async (currentPassword, newPassword) => {
        const { user } = await serverApi<{ user: SessionUser }>("/api/auth/change-password", { method: "POST", body: JSON.stringify({ currentPassword, newPassword }) });
        set({ user });
    },
}));

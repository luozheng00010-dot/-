import { create } from "zustand";
import { serverApi } from "@/services/server-api";
import { useAuthStore } from "@/stores/use-auth-store";

export type AccessLevel = "view" | "edit";
export type OwnerScope = "self" | "all" | string;
export type AccessibleMember = { id: string; username: string; role: "admin" | "member"; accessLevel: AccessLevel; isSelf: boolean };

type OwnerScopeStore = {
    scope: OwnerScope;
    members: AccessibleMember[];
    loading: boolean;
    setScope: (scope: OwnerScope) => void;
    loadMembers: () => Promise<void>;
};

export const useOwnerScopeStore = create<OwnerScopeStore>((set) => ({
    scope: "self",
    members: [],
    loading: false,
    setScope: (scope) => set({ scope }),
    loadMembers: async () => {
        if (!useAuthStore.getState().user) return;
        set({ loading: true });
        try {
            const { members } = await serverApi<{ members: AccessibleMember[] }>("/api/members/accessible");
            set((state) => ({ members, loading: false, scope: state.scope !== "self" && state.scope !== "all" && !members.some((item) => item.id === state.scope) ? "self" : state.scope }));
        } catch {
            set({ members: [], loading: false, scope: "self" });
        }
    },
}));

export function selectedOwnerId() {
    const { scope, members } = useOwnerScopeStore.getState();
    if (scope === "all") return useAuthStore.getState().user?.id || "";
    if (scope === "self") return useAuthStore.getState().user?.id || "";
    return members.find((item) => item.id === scope)?.id || "";
}

export function currentAccessLevel(): AccessLevel {
    const { scope, members } = useOwnerScopeStore.getState();
    if (scope === "self" || scope === "all") return "edit";
    return members.find((item) => item.id === scope)?.accessLevel || "view";
}

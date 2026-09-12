import { create } from "zustand";
import { nanoid } from "nanoid";
import { serverApi } from "@/services/server-api";
import { selectedOwnerId, useOwnerScopeStore, type AccessLevel, type OwnerScope } from "@/stores/use-owner-scope-store";
import { useAuthStore } from "@/stores/use-auth-store";

export type AssetKind = "text" | "image" | "video";
export type TextAsset = AssetBase<"text"> & { data: { content: string } };
export type ImageAsset = AssetBase<"image"> & { data: { dataUrl: string; storageKey?: string; width: number; height: number; bytes: number; mimeType: string } };
export type VideoAsset = AssetBase<"video"> & { data: { url: string; thumbnailUrl?: string; storageKey?: string; width: number; height: number; bytes: number; mimeType: string } };
export type Asset = TextAsset | ImageAsset | VideoAsset;

type AssetBase<T extends AssetKind> = {
    id: string; kind: T; title: string; coverUrl: string; tags: string[]; source?: string; note?: string; createdAt: string; updatedAt: string; metadata?: Record<string, unknown>;
    serverId?: string; revision?: number; ownerId?: string; ownerUsername?: string; createdByUsername?: string; accessLevel?: AccessLevel;
};
type AssetStore = {
    hydrated: boolean; loading: boolean; assets: Asset[];
    loadingError: string;
    loadAssets: (scope?: OwnerScope) => Promise<void>;
    retryLoadAssets: (scope?: OwnerScope) => Promise<void>;
    addAsset: (asset: Omit<Asset, "id" | "createdAt" | "updatedAt">) => string;
    updateAsset: (id: string, patch: Partial<Omit<Asset, "id" | "createdAt">>) => void;
    removeAsset: (id: string) => void;
    replaceAssets: (assets: Asset[]) => void;
    cleanupImages: (extra?: unknown) => void;
};
const timers = new Map<string, ReturnType<typeof setTimeout>>();
let loadVersion = 0;
function assetPayload(asset: Asset) { const { serverId, revision, ownerId, ownerUsername, createdByUsername, accessLevel, ...payload } = asset; return payload; }
function ownerAccess(ownerId?: string): AccessLevel {
    if (!ownerId) return "edit";
    const { members } = useOwnerScopeStore.getState();
    const currentUser = useAuthStore.getState().user;
    if (currentUser?.role === "admin" || currentUser?.id === ownerId) return "edit";
    return members.find((item) => item.id === ownerId)?.accessLevel || "view";
}
async function saveAsset(id: string) {
    const asset = useAssetStore.getState().assets.find((item) => item.id === id); if (!asset || asset.accessLevel === "view") return;
    try {
        const result = asset.serverId
            ? await serverApi<{ item: Asset }>(`/api/assets/${asset.serverId}`, { method: "PATCH", body: JSON.stringify({ revision: asset.revision || 1, title: asset.title, payload: assetPayload(asset) }) })
            : await serverApi<{ item: Asset }>("/api/assets", { method: "POST", body: JSON.stringify({ ownerId: selectedOwnerId(), kind: asset.kind, title: asset.title, legacyId: asset.id, payload: assetPayload(asset) }) });
        useAssetStore.setState((state) => ({ assets: state.assets.map((current) => current.id === id ? { ...result.item, accessLevel: "edit" } as Asset : current) }));
    } catch (error) { console.error("Asset save failed", error); }
}
function schedule(id: string) { const current = timers.get(id); if (current) clearTimeout(current); timers.set(id, setTimeout(() => { timers.delete(id); void saveAsset(id); }, 500)); }

export const useAssetStore = create<AssetStore>((set, get) => ({
    hydrated: false, loading: false, loadingError: "", assets: [],
    loadAssets: async (scope = useOwnerScopeStore.getState().scope) => {
        const requestVersion = ++loadVersion;
        set({ loading: true, loadingError: "" });
        try {
            const { items } = await serverApi<{ items: Asset[] }>(`/api/assets?owner=${encodeURIComponent(scope)}`);
            if (requestVersion !== loadVersion) return;
            set({ assets: items.map((item) => ({ ...item, accessLevel: ownerAccess(item.ownerId) } as Asset)), hydrated: true, loading: false, loadingError: "" });
        } catch (error) {
            if (requestVersion !== loadVersion) return;
            set({ hydrated: true, loading: false, loadingError: error instanceof Error ? error.message : "资产读取失败" });
        }
    },
    retryLoadAssets: (scope) => get().loadAssets(scope),
    addAsset: (source) => {
        const now = new Date().toISOString(); const id = nanoid(); const asset = { ...source, id, createdAt: now, updatedAt: now, accessLevel: "edit" } as Asset;
        set((state) => ({ assets: [asset, ...state.assets] })); void saveAsset(id); return id;
    },
    updateAsset: (id, patch) => { if (get().assets.find((item) => item.id === id)?.accessLevel === "view") return; set((state) => ({ assets: state.assets.map((asset) => asset.id === id ? { ...asset, ...patch, updatedAt: new Date().toISOString() } as Asset : asset) })); schedule(id); },
    removeAsset: (id) => { const asset = get().assets.find((item) => item.id === id); if (!asset || asset.accessLevel === "view") return; set((state) => ({ assets: state.assets.filter((item) => item.id !== id) })); if (asset.serverId) void serverApi(`/api/assets/${asset.serverId}`, { method: "DELETE" }); },
    replaceAssets: (assets) => set({ assets, hydrated: true }),
    cleanupImages: () => undefined,
}));

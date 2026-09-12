import { serverApi } from "@/services/server-api";
import { selectedOwnerId, useOwnerScopeStore } from "@/stores/use-owner-scope-store";

type StoredGeneration = Record<string, unknown> & { id: string; serverId?: string; revision?: number; title?: string; status?: string };
const serverIds = new Map<string, Map<string, string>>();
function idMap(kind: string) { let map = serverIds.get(kind); if (!map) { map = new Map(); serverIds.set(kind, map); } return map; }

export function createRemoteGenerationStore(kind: "image" | "video") {
    return {
        async iterate<T extends StoredGeneration, R>(callback: (value: T, key: string, iterationNumber: number) => R): Promise<R | undefined> {
            const scope = useOwnerScopeStore.getState().scope;
            const { items } = await serverApi<{ items: T[] }>(`/api/generations?kind=${kind}&owner=${encodeURIComponent(scope)}`);
            const map = idMap(kind); map.clear();
            let result: R | undefined;
            items.forEach((item, index) => { if (item.serverId) map.set(item.id, item.serverId); result = callback(item, item.id, index + 1); });
            return result;
        },
        async setItem<T extends StoredGeneration>(key: string, value: T): Promise<T> {
            const map = idMap(kind);
            const serverId = value.serverId || map.get(key);
            const payload = { ...value, serverId: undefined, revision: undefined, ownerId: undefined, ownerUsername: undefined, createdByUsername: undefined, updatedByUsername: undefined };
            const request = serverId
                ? serverApi<{ item: T }>(`/api/generations/${serverId}`, { method: "PATCH", body: JSON.stringify({ revision: value.revision || 1, title: value.title || "", status: value.status, payload }) })
                : serverApi<{ item: T }>("/api/generations", { method: "POST", body: JSON.stringify({ ownerId: selectedOwnerId(), kind, title: value.title || "", status: value.status || "success", legacyId: key, payload }) });
            const { item } = await request;
            if (item.serverId) map.set(item.id, item.serverId);
            return item;
        },
        async removeItem(key: string) { const serverId = idMap(kind).get(key) || key; await serverApi(`/api/generations/${serverId}`, { method: "DELETE" }); idMap(kind).delete(key); },
        async clear() { const values: StoredGeneration[] = []; await this.iterate<StoredGeneration, void>((value) => { values.push(value); }); await Promise.all(values.map((value) => this.removeItem(value.id))); },
    };
}

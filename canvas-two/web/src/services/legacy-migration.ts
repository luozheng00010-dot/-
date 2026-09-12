import localforage from "localforage";
import { serverApi } from "@/services/server-api";
import type { SessionUser } from "@/stores/use-auth-store";

const appState = localforage.createInstance({ name: "infinite-canvas", storeName: "app_state" });
const images = localforage.createInstance({ name: "infinite-canvas", storeName: "image_files" });
const media = localforage.createInstance({ name: "infinite-canvas", storeName: "media_files" });
const imageLogs = localforage.createInstance({ name: "infinite-canvas", storeName: "image_generation_logs" });
const videoLogs = localforage.createInstance({ name: "infinite-canvas", storeName: "video_generation_logs" });

export type LegacySnapshot = { projects: Record<string, unknown>[]; assets: Record<string, unknown>[]; imageLogs: Record<string, unknown>[]; videoLogs: Record<string, unknown>[]; storageKeys: string[]; bytes: number };
function persistedList(value: string | null, key: string) { if (!value) return []; try { const parsed = JSON.parse(value) as { state?: Record<string, unknown> }; const list = parsed.state?.[key]; return Array.isArray(list) ? list as Record<string, unknown>[] : []; } catch { return []; } }
async function readStore(store: LocalForage) { const values: Record<string, unknown>[] = []; await store.iterate<Record<string, unknown>, void>((value) => { if (value && typeof value === "object") values.push(value); }); return values; }
function collectStorageKeys(value: unknown, result = new Set<string>()) { if (!value || typeof value !== "object") return result; if ("storageKey" in value && typeof value.storageKey === "string" && !value.storageKey.startsWith("media:")) result.add(value.storageKey); Object.values(value).forEach((item) => Array.isArray(item) ? item.forEach((child) => collectStorageKeys(child, result)) : collectStorageKeys(item, result)); return result; }
export async function readLegacySnapshot(): Promise<LegacySnapshot> {
    const [canvasRaw, assetRaw, oldImageLogs, oldVideoLogs] = await Promise.all([appState.getItem<string>("infinite-canvas:canvas_store"), appState.getItem<string>("infinite-canvas:asset_store"), readStore(imageLogs), readStore(videoLogs)]);
    const projects = persistedList(canvasRaw, "projects"); const assets = persistedList(assetRaw, "assets"); const storageKeys = [...collectStorageKeys({ projects, assets, oldImageLogs, oldVideoLogs })];
    let bytes = 0; for (const key of storageKeys) { const blob = key.startsWith("image:") ? await images.getItem<Blob>(key) : await media.getItem<Blob>(key); bytes += blob?.size || 0; }
    return { projects, assets, imageLogs: oldImageLogs, videoLogs: oldVideoLogs, storageKeys, bytes };
}
function rewrite(value: unknown, mapping: Map<string, { storageKey: string; url: string }>): unknown {
    if (Array.isArray(value)) return value.map((item) => rewrite(item, mapping));
    if (!value || typeof value !== "object") return value;
    const source = value as Record<string, unknown>; const mapped = typeof source.storageKey === "string" ? mapping.get(source.storageKey) : undefined;
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(source)) result[key] = rewrite(item, mapping);
    if (mapped) { result.storageKey = mapped.storageKey; for (const key of ["content", "dataUrl", "url"]) if (typeof result[key] === "string") result[key] = mapped.url; if (typeof result.coverUrl === "string" && (result.coverUrl.startsWith("blob:") || result.coverUrl.startsWith("data:"))) result.coverUrl = mapped.url; }
    return result;
}
export function migrationMarker(user: SessionUser) { return `infinite-canvas:server-migrated:${user.id}`; }
export async function migrateLegacySnapshot(snapshot: LegacySnapshot, user: SessionUser, onProgress?: (value: string) => void) {
    const mapping = new Map<string, { storageKey: string; url: string }>(); let index = 0;
    for (const key of snapshot.storageKeys) {
        index += 1; onProgress?.(`上传媒体 ${index}/${snapshot.storageKeys.length}`);
        const blob = key.startsWith("image:") ? await images.getItem<Blob>(key) : await media.getItem<Blob>(key); if (!blob) continue;
        const form = new FormData(); form.append("file", blob, key.replace(/[^A-Za-z0-9._-]/g, "_")); form.append("ownerId", user.id); form.append("legacyStorageKey", key);
        const { item } = await serverApi<{ item: { id: string; url: string } }>("/api/media", { method: "POST", body: form }); mapping.set(key, { storageKey: `media:${item.id}`, url: item.url });
    }
    for (const [i, source] of snapshot.projects.entries()) { onProgress?.(`迁移画布 ${i + 1}/${snapshot.projects.length}`); const project = rewrite(source, mapping) as Record<string, unknown>; await serverApi("/api/canvases", { method: "POST", body: JSON.stringify({ ownerId: user.id, title: String(project.title || "导入画布"), legacyId: String(source.id || ""), payload: { nodes: project.nodes || [], connections: project.connections || [], chatSessions: project.chatSessions || [], activeChatId: project.activeChatId || null, backgroundMode: project.backgroundMode || "lines", showImageInfo: project.showImageInfo || false, viewport: project.viewport || { x: 0, y: 0, k: 1 } } }) }); }
    for (const [i, source] of snapshot.assets.entries()) { onProgress?.(`迁移资产 ${i + 1}/${snapshot.assets.length}`); const asset = rewrite(source, mapping) as Record<string, unknown>; await serverApi("/api/assets", { method: "POST", body: JSON.stringify({ ownerId: user.id, kind: String(asset.kind || "text"), title: String(asset.title || ""), legacyId: String(source.id || ""), payload: asset }) }); }
    for (const [kind, logs] of [["image", snapshot.imageLogs], ["video", snapshot.videoLogs]] as const) for (const [i, source] of logs.entries()) { onProgress?.(`迁移${kind === "image" ? "生图" : "视频"}记录 ${i + 1}/${logs.length}`); const log = rewrite(source, mapping) as Record<string, unknown>; await serverApi("/api/generations", { method: "POST", body: JSON.stringify({ ownerId: user.id, kind, title: String(log.title || ""), status: String(log.status || "success"), legacyId: String(source.id || ""), payload: log }) }); }
    localStorage.setItem(migrationMarker(user), new Date().toISOString());
}

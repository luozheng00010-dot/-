import localforage from "localforage";
import { apiUrl } from "@/lib/app-path";
import { selectedOwnerId } from "@/stores/use-owner-scope-store";
import { serverApi } from "@/services/server-api";

export type UploadedFile = { url: string; thumbnailUrl?: string; storageKey: string; bytes: number; mimeType: string; width?: number; height?: number; durationMs?: number };
const legacyStore = localforage.createInstance({ name: "infinite-canvas", storeName: "media_files" });
function mediaUrl(storageKey: string) { return apiUrl(`media/${storageKey.slice("media:".length)}/content`); }
export function mediaThumbnailUrl(storageKey: string) { return apiUrl(`media/${storageKey.slice("media:".length)}/thumbnail`); }

export async function uploadMediaFile(input: string | Blob, _prefix = "file"): Promise<UploadedFile> {
    const blob = typeof input === "string" ? await (await fetch(input)).blob() : input;
    const localUrl = URL.createObjectURL(blob);
    const isVideo = blob.type.startsWith("video/") || _prefix.startsWith("video");
    const isAudio = blob.type.startsWith("audio/") || _prefix.startsWith("audio");
    const video = isVideo ? await readVideoMetaAndThumbnail(localUrl) : null;
    const meta = video ? { width: video.width, height: video.height, durationMs: video.durationMs } : isAudio ? await readAudioMeta(localUrl) : {};
    const mimeType = isVideo && !blob.type.startsWith("video/") ? "video/mp4" : isAudio && !blob.type.startsWith("audio/") ? "audio/mpeg" : blob.type || "application/octet-stream";
    const uploadBlob = blob.type === mimeType ? blob : new Blob([blob], { type: mimeType });
    URL.revokeObjectURL(localUrl);
    const form = new FormData();
    form.append("file", uploadBlob, "media");
    if (video?.thumbnail) form.append("thumbnail", video.thumbnail, "thumbnail.webp");
    form.append("ownerId", selectedOwnerId());
    const { item } = await serverApi<{ item: { id: string; url: string; thumbnailUrl?: string; bytes: number; mimeType: string } }>("/api/media", { method: "POST", body: form });
    return { url: item.url, thumbnailUrl: item.thumbnailUrl, storageKey: `media:${item.id}`, bytes: item.bytes, mimeType: item.mimeType || "application/octet-stream", ...meta };
}
export async function uploadMediaThumbnail(storageKey: string, thumbnail: Blob) {
    const form = new FormData();
    form.append("thumbnail", thumbnail, "thumbnail.webp");
    const { item } = await serverApi<{ item: { thumbnailUrl?: string } }>(`/api/media/${storageKey.slice("media:".length)}/thumbnail`, { method: "POST", body: form });
    return item.thumbnailUrl || mediaThumbnailUrl(storageKey);
}
export async function resolveMediaUrl(storageKey?: string, fallback = "") { if (!storageKey) return fallback; if (storageKey.startsWith("media:")) return mediaUrl(storageKey); const blob = await legacyStore.getItem<Blob>(storageKey); return blob ? URL.createObjectURL(blob) : fallback; }
export async function getMediaBlob(storageKey: string) { if (storageKey.startsWith("media:")) return (await fetch(mediaUrl(storageKey))).blob(); return legacyStore.getItem<Blob>(storageKey); }
export async function setMediaBlob(storageKey: string, blob: Blob) { await legacyStore.setItem(storageKey, blob); return URL.createObjectURL(blob); }
export async function deleteStoredMedia(keys: Iterable<string>) { await Promise.all(Array.from(new Set(keys)).filter((key) => !key.startsWith("media:")).map((key) => legacyStore.removeItem(key))); }
export async function cleanupUnusedMedia(_usedData: unknown) { return; }
export function collectMediaStorageKeys(value: unknown, keys = new Set<string>()) { if (!value || typeof value !== "object") return keys; if ("storageKey" in value && typeof value.storageKey === "string" && value.storageKey.includes(":")) keys.add(value.storageKey); Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectMediaStorageKeys(child, keys)) : collectMediaStorageKeys(item, keys))); return keys; }
async function readVideoMetaAndThumbnail(url: string) {
    const video = document.createElement("video");
    video.preload = "auto";
    video.muted = true;
    video.playsInline = true;
    video.src = url;
    await new Promise<void>((resolve) => {
        video.onloadedmetadata = () => resolve();
        video.onerror = () => resolve();
    });
    const width = video.videoWidth || 1280;
    const height = video.videoHeight || 720;
    let thumbnail: Blob | undefined;
    if (video.videoWidth && video.videoHeight) {
        try {
            await new Promise<void>((resolve) => {
                if (video.readyState >= 2) resolve();
                else {
                    video.onloadeddata = () => resolve();
                    video.onerror = () => resolve();
                }
            });
            await new Promise<void>((resolve) => {
                if (video.duration > 0.1) {
                    video.onseeked = () => resolve();
                    video.currentTime = Math.min(0.1, Math.max(0, video.duration - 0.01));
                } else resolve();
            });
            const scale = Math.min(1, 512 / Math.max(width, height));
            const canvas = document.createElement("canvas");
            canvas.width = Math.max(1, Math.round(width * scale));
            canvas.height = Math.max(1, Math.round(height * scale));
            canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
            thumbnail = await new Promise<Blob | undefined>((resolve) => canvas.toBlob((value) => resolve(value || undefined), "image/webp", 0.82));
        } catch {
            thumbnail = undefined;
        }
    }
    return { width, height, durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : undefined, thumbnail };
}
export async function extractVideoThumbnail(url: string) {
    return (await readVideoMetaAndThumbnail(url)).thumbnail;
}
function readAudioMeta(url: string) { return new Promise<{ durationMs?: number }>((resolve) => { const audio = document.createElement("audio"); const done = () => resolve({ durationMs: Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : undefined }); audio.onloadedmetadata = done; audio.onerror = done; audio.src = url; }); }

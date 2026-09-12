import localforage from "localforage";
import { apiUrl } from "@/lib/app-path";
import { readImageMeta } from "@/lib/image-utils";
import { selectedOwnerId } from "@/stores/use-owner-scope-store";
import { serverApi } from "@/services/server-api";

export type UploadedImage = { url: string; thumbnailUrl: string; storageKey: string; width: number; height: number; bytes: number; mimeType: string };
const legacyStore = localforage.createInstance({ name: "infinite-canvas", storeName: "image_files" });

function mediaUrl(storageKey: string) { return apiUrl(`media/${storageKey.slice("media:".length)}/content`); }
export function imageThumbnailUrl(storageKey?: string, fallback = "") { return storageKey?.startsWith("media:") ? apiUrl(`media/${storageKey.slice("media:".length)}/thumbnail`) : fallback; }

export async function uploadImage(input: string | Blob, ownerId?: string, visibility?: "public", origin?: "kb"): Promise<UploadedImage> {
    const blob = typeof input === "string" ? await (await fetch(input)).blob() : input;
    const localUrl = URL.createObjectURL(blob);
    const meta = await readImageMeta(localUrl);
    URL.revokeObjectURL(localUrl);
    const form = new FormData();
    form.append("file", blob, "image");
    form.append("ownerId", ownerId || selectedOwnerId());
    if (visibility) form.append("visibility", visibility);
    if (origin) form.append("origin", origin);
    const { item } = await serverApi<{ item: { id: string; url: string; thumbnailUrl?: string; bytes: number; mimeType: string } }>("/api/media", { method: "POST", body: form });
    return { url: item.url, thumbnailUrl: item.thumbnailUrl || item.url, storageKey: `media:${item.id}`, width: meta.width, height: meta.height, bytes: item.bytes, mimeType: item.mimeType || meta.mimeType };
}

export async function ensureUploadedImage(image: { dataUrl: string; thumbnailUrl?: string; storageKey?: string; width?: number; height?: number; bytes?: number; mimeType?: string }): Promise<UploadedImage> {
    if (!image.storageKey?.startsWith("media:")) return uploadImage(image.dataUrl);
    return {
        url: image.dataUrl,
        thumbnailUrl: image.thumbnailUrl || imageThumbnailUrl(image.storageKey, image.dataUrl),
        storageKey: image.storageKey,
        width: image.width || 0,
        height: image.height || 0,
        bytes: image.bytes || 0,
        mimeType: image.mimeType || "image/png",
    };
}

export async function resolveImageUrl(storageKey?: string, fallback = "") {
    if (!storageKey) return fallback;
    if (storageKey.startsWith("media:")) return mediaUrl(storageKey);
    const blob = await legacyStore.getItem<Blob>(storageKey);
    return blob ? URL.createObjectURL(blob) : fallback;
}

export async function getImageBlob(storageKey: string) {
    if (storageKey.startsWith("media:")) return (await fetch(mediaUrl(storageKey))).blob();
    return legacyStore.getItem<Blob>(storageKey);
}

export async function setImageBlob(storageKey: string, blob: Blob) {
    await legacyStore.setItem(storageKey, blob);
    return URL.createObjectURL(blob);
}

export async function imageToDataUrl(image: { url?: string; dataUrl?: string; storageKey?: string }) {
    const url = image.dataUrl || (await resolveImageUrl(image.storageKey, image.url || ""));
    if (!url || url.startsWith("data:")) return url;
    return blobToDataUrl(await (await fetch(url)).blob());
}

export async function deleteStoredImages(keys: Iterable<string>) {
    await Promise.all(Array.from(new Set(keys)).filter((key) => !key.startsWith("media:")).map((key) => legacyStore.removeItem(key)));
}
export async function cleanupUnusedImages(_usedData: unknown) { return; }
export function collectImageStorageKeys(value: unknown, keys = new Set<string>()) {
    if (!value || typeof value !== "object") return keys;
    if ("storageKey" in value && typeof value.storageKey === "string" && (value.storageKey.startsWith("image:") || value.storageKey.startsWith("media:"))) keys.add(value.storageKey);
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectImageStorageKeys(child, keys)) : collectImageStorageKeys(item, keys)));
    return keys;
}
function blobToDataUrl(blob: Blob) { return new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result || "")); reader.onerror = () => reject(new Error("读取图片失败")); reader.readAsDataURL(blob); }); }

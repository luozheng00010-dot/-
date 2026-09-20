import { apiUrl } from "@/lib/app-path";
import { jsonBody, serverApi } from "./server-api";

export interface LibraryOption { id: string; name: string }
export type MaterialAnnotation = { summary: string; parts: string[]; actions: string[]; tags: string[]; shot: string; scene: string; colors: string[]; warnings: string[]; generic: boolean; needsReview: boolean; userNotes: string };
export interface LocalVideo {
    id: string; fileName: string; bytes: number; createdAt: string; notes?: string | null;
    skuId: string; categoryId: string; sku: LibraryOption; category: LibraryOption;
    uploadedBy: { username: string };
    duration?: number; width?: number; height?: number; thumbnail?: string; disabled: boolean; revision: number;
    analysisStatus: string; analysisError?: string; annotation?: MaterialAnnotation; proposedAnnotation?: MaterialAnnotation;
}
const base = "/api/local-materials";
export type LibraryKind = "skus" | "categories";
export const listLibraryOptions = (kind: LibraryKind) => serverApi<LibraryOption[]>(`${base}/${kind}`);
export const saveLibraryOption = (kind: LibraryKind, name: string, id?: string) => serverApi<LibraryOption>(`${base}/${kind}${id ? `/${id}` : ""}`, { method: id ? "PATCH" : "POST", ...jsonBody({ name }) });
export const deleteLibraryOption = (kind: LibraryKind, id: string) => serverApi(`${base}/${kind}/${id}`, { method: "DELETE" });
export const availableCategories = (skuId: string) => serverApi<LibraryOption[]>(`${base}/available-categories?skuId=${encodeURIComponent(skuId)}`);
export function listLocalVideos(input: { skuId?: string; categoryIds?: string[]; search?: string; page?: number; pageSize?: number } = {}, signal?: AbortSignal) {
    const query = new URLSearchParams();
    if (input.skuId) query.set("skuId", input.skuId);
    if (input.categoryIds?.length) query.set("categoryIds", input.categoryIds.join(","));
    if (input.search) query.set("search", input.search);
    query.set("page", String(input.page ?? 1));
    query.set("pageSize", String(input.pageSize ?? 20));
    return serverApi<{ items: LocalVideo[]; total: number }>(`${base}?${query}`, { signal });
}
export function uploadLocalVideo(file: File, skuId: string, categoryId: string, notes?: string) {
    const body = new FormData();
    body.append("skuId", skuId);
    body.append("categoryId", categoryId);
    if (notes?.trim()) body.append("notes", notes.trim());
    body.append("file", file);
    return serverApi<LocalVideo>(`${base}/upload`, { method: "POST", body });
}
export const assignLocalVideo = (id: string, skuId: string, categoryId: string) => serverApi<LocalVideo>(`${base}/${id}`, { method: "PATCH", ...jsonBody({ skuId, categoryId }) });
export const deleteLocalVideo = (id: string) => serverApi(`${base}/${id}`, { method: "DELETE" });
export const localVideoUrl = (id: string) => apiUrl(`${base}/${id}/preview`);
export const analyzeMaterials = (ids: string[]) => serverApi(`${base}/analyze`, { method: "POST", ...jsonBody({ ids }) });
export const annotateMaterial = (id: string, body: { revision: number; annotation?: MaterialAnnotation; disabled?: boolean; acceptProposed?: boolean }) => serverApi(`${base}/${id}/annotation`, { method: "PATCH", ...jsonBody(body) });
export const materialIndexStatus = () => serverApi<{ total: number; ready: number; configured: boolean }>(`${base}/index-status`);

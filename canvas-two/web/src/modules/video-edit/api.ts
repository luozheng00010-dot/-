import { apiUrl } from "@/lib/app-path";
import { jsonBody, serverApi } from "@/services/server-api";
import type {
    GapReport,
    SentencePlan,
    TimelineItem,
    VideoCategory,
    VideoChannelOption,
    VideoExportTask,
    VideoIngestBatch,
    VideoIngestBatchDetail,
    VideoMaterial,
    VideoMaterialListQuery,
    VideoScript,
    VideoSettings,
    VideoSku,
    VideoTimeline,
} from "./types";

/** 自动剪辑 API 客户端；模块内自包含，只依赖公共层（serverApi 带 cookie 鉴权与统一错误）。 */

/** MediaFile id → 可直接用于 <img>/<a> 的内容地址（/api/media/:id/content，cookie 同源自动携带）。 */
export function mediaContentUrl(mediaId: string) {
    return apiUrl(`media/${mediaId}/content`);
}

export async function listVideoCategories() {
    return serverApi<{ categories: VideoCategory[] }>("/api/video/categories");
}

// ===== 货号管理（先建后用） =====

export async function listVideoSkus() {
    return serverApi<{ skus: VideoSku[] }>("/api/video/skus");
}

export async function createVideoSku(name: string) {
    return serverApi<{ sku: VideoSku }>("/api/video/skus", { method: "POST", ...jsonBody({ name }) });
}

export async function deleteVideoSku(id: string) {
    return serverApi<{ ok: boolean }>(`/api/video/skus/${id}`, { method: "DELETE" });
}

export async function createIngestBatch(input: { sku: string; categoryId: string; files: File[] }) {
    const form = new FormData();
    form.append("sku", input.sku);
    form.append("categoryId", input.categoryId);
    for (const file of input.files) form.append("files", file);
    return serverApi<{ batch: VideoIngestBatch }>("/api/video/ingest-batches", { method: "POST", body: form });
}

export async function getIngestBatch(id: string) {
    return serverApi<{ batch: VideoIngestBatch; failedMaterials: VideoIngestBatchDetail["failedMaterials"] }>(`/api/video/ingest-batches/${id}`);
}

export async function listVideoMaterials(query: VideoMaterialListQuery = {}) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === "" || value === null) continue;
        if (Array.isArray(value)) {
            if (value.length) params.set(key, value.join(","));
        } else {
            params.set(key, String(value));
        }
    }
    const suffix = params.size ? `?${params.toString()}` : "";
    return serverApi<{ total: number; items: VideoMaterial[] }>(`/api/video/materials${suffix}`);
}

export interface VideoMaterialPatch {
    categoryId?: string;
    description?: string;
    shotType?: string;
    motion?: string;
    productVisible?: boolean;
    reviewStatus?: "none" | "warn_confirmed" | "corrected";
    status?: "active" | "archived";
}

export async function updateVideoMaterial(id: string, patch: VideoMaterialPatch) {
    return serverApi<{ material: VideoMaterial }>(`/api/video/materials/${id}`, { method: "PATCH", ...jsonBody(patch) });
}

export async function createVideoScript(input: { title: string; sku: string; rawText: string }) {
    return serverApi<{ script: VideoScript }>("/api/video/scripts", { method: "POST", ...jsonBody(input) });
}

export async function getVideoScript(id: string) {
    return serverApi<{ script: VideoScript }>(`/api/video/scripts/${id}`);
}

export async function splitVideoScript(id: string) {
    return serverApi<{ script: VideoScript }>(`/api/video/scripts/${id}/split`, { method: "POST" });
}

export async function matchVideoScript(id: string, sentences?: SentencePlan[]) {
    const body = sentences ? { sentences } : {};
    return serverApi<{ timeline: VideoTimeline & { gapReport: GapReport | null } }>(`/api/video/scripts/${id}/match`, { method: "POST", ...jsonBody(body) });
}

export async function getVideoTimeline(id: string) {
    return serverApi<{ timeline: VideoTimeline }>(`/api/video/timelines/${id}`);
}

/** 覆盖保存时间线（P2 F1）：items 全量覆盖，version+1，status="edited"；违规 400 带中文原因。 */
export async function putTimeline(id: string, items: TimelineItem[]) {
    return serverApi<{ timeline: VideoTimeline }>(`/api/video/timelines/${id}`, { method: "PUT", ...jsonBody({ items }) });
}

/** 单句重匹配（P2 F1）：仅该句重新挑选素材，其余句子原样保留，version+1。 */
export async function rematchTimeline(id: string, sentenceId: number) {
    return serverApi<{ timeline: VideoTimeline }>(`/api/video/timelines/${id}/rematch`, { method: "POST", ...jsonBody({ sentenceId }) });
}

export async function exportVideoTimeline(id: string, resolution?: string) {
    const body = resolution ? { resolution } : {};
    return serverApi<{ task: VideoExportTask }>(`/api/video/timelines/${id}/export`, { method: "POST", ...jsonBody(body) });
}

export async function listVideoExportTasks() {
    return serverApi<{ tasks: VideoExportTask[] }>("/api/video/exports");
}

export async function getVideoExportTask(id: string) {
    return serverApi<{ task: VideoExportTask }>(`/api/video/exports/${id}`);
}

// ===== 管理设置 =====

export async function getVideoAdminSettings() {
    return serverApi<{ settings: VideoSettings; channels: VideoChannelOption[] }>("/api/video/admin/settings");
}

export async function updateVideoAdminSettings(input: VideoSettings) {
    return serverApi<{ settings: VideoSettings }>("/api/video/admin/settings", { method: "PUT", ...jsonBody(input) });
}

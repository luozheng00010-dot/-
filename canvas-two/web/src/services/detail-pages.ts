import { serverApi } from "@/services/server-api";
import { useOwnerScopeStore } from "@/stores/use-owner-scope-store";
import type { DetailPageListQuery, DetailPageListResponse, DetailPageMedia, DetailPagePair, DetailPagePairReference, DetailPagePairStatus, DetailPagePairVariant, DetailPageProduct, DetailPageProject } from "@/types/detail-page";

const MIN_REFERENCES = 1;
const MAX_REFERENCES = 18;

type MediaResponse = Partial<DetailPageMedia> & { id?: string; mediaId?: string };
type PairResponse = Partial<DetailPagePair>;
type ProjectResponse = Partial<DetailPageProject> & {
    product?: Partial<DetailPageProduct>;
    productImage?: MediaResponse;
    pairs?: PairResponse[];
};

function normalizeMedia(media?: MediaResponse): DetailPageMedia {
    const mediaId = media?.mediaId || media?.id || "";
    return {
        id: media?.id || mediaId,
        mediaId,
        fileName: media?.fileName || "媒体文件",
        mimeType: media?.mimeType || "image/png",
        bytes: Number(media?.bytes || 0),
        url: media?.url || "",
        thumbnailUrl: media?.thumbnailUrl || media?.url || "",
        storageKey: media?.storageKey || (mediaId ? `media:${mediaId}` : ""),
        width: media?.width == null ? undefined : Number(media.width),
        height: media?.height == null ? undefined : Number(media.height),
    };
}

function normalizePair(pair: PairResponse, projectId: string, index: number): DetailPagePair {
    const referenceImage = normalizeMedia(pair.referenceImage);
    const resultImage = pair.resultImage ? normalizeMedia(pair.resultImage) : undefined;
    const rawReferences = (Array.isArray((pair as any).references) ? (pair as any).references : []).map((raw: any) => ({ id: raw.id || "", mediaId: raw.mediaId || raw.image?.mediaId || "", kind: raw.kind || "upload", selected: raw.selected !== false, sortOrder: Number(raw.sortOrder || 0), image: normalizeMedia(raw.image) })) as DetailPagePairReference[];
    if (!rawReferences.some((item) => item.kind === "original") && referenceImage.mediaId) rawReferences.unshift({ id: `original-${pair.id || index}`, mediaId: referenceImage.mediaId, kind: "original", selected: true, sortOrder: -1, image: referenceImage });
    if (resultImage && !rawReferences.some((item) => item.kind === "result")) rawReferences.push({ id: `result-${pair.id || index}`, mediaId: resultImage.mediaId, kind: "result", selected: true, sortOrder: rawReferences.length, image: resultImage });
    return {
        id: pair.id || "",
        projectId: pair.projectId || projectId,
        sortOrder: Number.isInteger(pair.sortOrder) ? Number(pair.sortOrder) : index,
        referenceMediaId: pair.referenceMediaId || referenceImage.mediaId,
        referenceImage,
        resultMediaId: pair.resultMediaId || resultImage?.mediaId,
        resultImage,
        referenceWidth: Number(pair.referenceWidth || referenceImage.width || 0),
        referenceHeight: Number(pair.referenceHeight || referenceImage.height || 0),
        prompt: pair.prompt || "",
        generationModel: pair.generationModel || undefined,
        generationChannelId: pair.generationChannelId || undefined,
        generationResolution: (pair.generationResolution === "2k" || pair.generationResolution === "4k" ? pair.generationResolution : "1k") as DetailPagePair["generationResolution"],
        generationAspectRatio: (["original", "1:1", "3:2", "2:3", "16:9", "9:16", "4:3", "3:4", "21:9"].includes(String(pair.generationAspectRatio)) ? pair.generationAspectRatio : "original") as DetailPagePair["generationAspectRatio"],
        generationQuality: (["auto", "low", "medium", "high"].includes(String(pair.generationQuality)) ? pair.generationQuality : "auto") as DetailPagePair["generationQuality"],
        resolvedPrompt: pair.resolvedPrompt || undefined,
        status: (pair.status as DetailPagePairStatus) || "draft",
        activeTaskId: pair.activeTaskId || undefined,
        error: pair.error || undefined,
        revision: Number(pair.revision || 1),
        updatedAt: pair.updatedAt,
        modificationVariants: (Array.isArray(pair.modificationVariants) ? pair.modificationVariants : []).map((raw) => normalizeVariant(raw as Partial<DetailPagePairVariant>)),
        references: rawReferences.sort((a, b) => a.sortOrder - b.sortOrder),
    };
}

function normalizeVariant(raw: Partial<DetailPagePairVariant>): DetailPagePairVariant {
    const image = raw.image ? normalizeMedia(raw.image as MediaResponse) : undefined;
    return { id: raw.id || "", pairId: raw.pairId || "", mediaId: raw.mediaId || image?.mediaId, image, sourceMediaId: raw.sourceMediaId || undefined, kind: raw.kind || "retry", status: raw.status || "draft", prompt: raw.prompt || "", resolvedPrompt: raw.resolvedPrompt || undefined, activeTaskId: raw.activeTaskId || undefined, error: raw.error || undefined, revision: Number(raw.revision || 1), createdAt: raw.createdAt || "", updatedAt: raw.updatedAt || "" };
}

function normalizeProduct(product?: ProjectResponse["product"]): DetailPageProduct {
    return {
        id: product?.id || "",
        name: product?.name || "",
        brand: product?.brand || "",
        productType: product?.productType || "",
        material: product?.material || "",
        sellingPoints: Array.isArray(product?.sellingPoints) ? product.sellingPoints.filter((item): item is string => typeof item === "string") : [],
        instruction: product?.instruction || "",
        resultImage: product?.resultImage ? normalizeMedia(product.resultImage) : undefined,
    };
}

function normalizeProject(raw: ProjectResponse): DetailPageProject {
    const product = normalizeProduct(raw.product);
    const productImage = normalizeMedia(raw.productImage || product.resultImage);
    const pairs = (Array.isArray(raw.pairs) ? raw.pairs : []).map((pair, index) => normalizePair(pair, raw.id || "", index)).sort((a, b) => a.sortOrder - b.sortOrder);
    return {
        id: raw.id || "",
        ownerId: raw.ownerId || "",
        ownerUsername: raw.ownerUsername || "",
        productId: raw.productId || product.id,
        productMediaId: raw.productMediaId || productImage.mediaId,
        product,
        productImage,
        title: raw.title || "",
        pairs,
        status: (raw.status as DetailPageProject["status"]) || "draft",
        error: raw.error || undefined,
        revision: Number(raw.revision || 1),
        accessLevel: raw.accessLevel as DetailPageProject["accessLevel"],
        createdAt: raw.createdAt || "",
        updatedAt: raw.updatedAt || "",
    };
}

function unwrapProject(payload: { item?: ProjectResponse } | ProjectResponse): DetailPageProject {
    const item = "item" in payload ? payload.item : payload;
    return normalizeProject((item || {}) as ProjectResponse);
}

function assertReferenceCount(ids: string[]) {
    if (ids.length < MIN_REFERENCES || ids.length > MAX_REFERENCES) throw new Error(`参考详情页图片数量必须为 ${MIN_REFERENCES}-${MAX_REFERENCES} 张`);
    if (new Set(ids).size !== ids.length) throw new Error("参考详情页图片不能重复");
}

export async function listDetailPageProjects(query: DetailPageListQuery = {}): Promise<DetailPageListResponse> {
    const params = new URLSearchParams({ owner: query.owner || useOwnerScopeStore.getState().scope, page: String(query.page || 1), pageSize: String(query.pageSize || 24) });
    if (query.keyword?.trim()) params.set("keyword", query.keyword.trim());
    const result = await serverApi<{ items: ProjectResponse[]; total: number; page: number; pageSize: number }>(`/api/detail-page-projects?${params}`);
    return { ...result, items: (result.items || []).map(normalizeProject) };
}

export async function getDetailPageProject(id: string): Promise<DetailPageProject> {
    return unwrapProject(await serverApi<{ item?: ProjectResponse } | ProjectResponse>(`/api/detail-page-projects/${id}`));
}

export async function createDetailPageProject(input: { productId: string; title?: string; referenceMediaIds: string[] }): Promise<DetailPageProject> {
    assertReferenceCount(input.referenceMediaIds);
    return unwrapProject(await serverApi<{ item?: ProjectResponse } | ProjectResponse>("/api/detail-page-projects", { method: "POST", body: JSON.stringify({ productId: input.productId, title: input.title?.trim(), referenceMediaIds: input.referenceMediaIds }) }));
}

export async function updateDetailPageProject(id: string, input: { revision: number; title: string }): Promise<DetailPageProject> {
    return unwrapProject(await serverApi<{ item?: ProjectResponse } | ProjectResponse>(`/api/detail-page-projects/${id}`, { method: "PATCH", body: JSON.stringify({ revision: input.revision, title: input.title.trim() }) }));
}

export async function updateDetailPagePairPrompt(projectId: string, pairId: string, input: { revision: number; prompt: string; generationModel?: string; generationChannelId?: string; generationResolution?: string; generationAspectRatio?: string; generationQuality?: string }): Promise<DetailPageProject> {
    return unwrapProject(await serverApi<{ item?: ProjectResponse } | ProjectResponse>(`/api/detail-page-projects/${projectId}/pairs/${pairId}`, { method: "PATCH", body: JSON.stringify(input) }));
}

export async function addDetailPagePairReference(projectId: string, pairId: string, input: { revision: number; mediaId: string; kind?: "original" | "result" | "upload" }): Promise<DetailPageProject> {
    return unwrapProject(await serverApi<{ item?: ProjectResponse } | ProjectResponse>(`/api/detail-page-projects/${projectId}/pairs/${pairId}/references`, { method: "POST", body: JSON.stringify(input) }));
}

export async function updateDetailPagePairReference(projectId: string, pairId: string, referenceId: string, input: { revision: number; selected?: boolean; sortOrder?: number }): Promise<DetailPageProject> {
    return unwrapProject(await serverApi<{ item?: ProjectResponse } | ProjectResponse>(`/api/detail-page-projects/${projectId}/pairs/${pairId}/references/${referenceId}`, { method: "PATCH", body: JSON.stringify(input) }));
}

export async function deleteDetailPagePairReference(projectId: string, pairId: string, referenceId: string, revision: number): Promise<DetailPageProject> {
    return unwrapProject(await serverApi<{ item?: ProjectResponse } | ProjectResponse>(`/api/detail-page-projects/${projectId}/pairs/${pairId}/references/${referenceId}`, { method: "DELETE", body: JSON.stringify({ revision }) }));
}

export async function generateDetailPageProject(projectId: string, input: { revision?: number; model: string; channelId: string; clientRequestIdPrefix?: string }): Promise<DetailPageProject> {
    return unwrapProject(await serverApi<{ item?: ProjectResponse } | ProjectResponse>(`/api/detail-page-projects/${projectId}/generate`, { method: "POST", body: JSON.stringify(input) }));
}

export async function generateDetailPagePair(projectId: string, pairId: string, input: { revision?: number; model: string; channelId: string; clientRequestId?: string; prompt?: string; generationResolution?: string; generationAspectRatio?: string; generationQuality?: string }): Promise<DetailPageProject> {
    return unwrapProject(await serverApi<{ item?: ProjectResponse } | ProjectResponse>(`/api/detail-page-projects/${projectId}/pairs/${pairId}/generate`, { method: "POST", body: JSON.stringify(input) }));
}

export async function setDetailPagePairResult(projectId: string, pairId: string, input: { revision: number; status: "running" | "succeeded" | "failed" | "interrupted"; mediaId?: string; prompt?: string; error?: string; generationAspectRatio?: string }): Promise<DetailPageProject> {
    return unwrapProject(await serverApi<{ item?: ProjectResponse } | ProjectResponse>(`/api/detail-page-projects/${projectId}/pairs/${pairId}/result`, { method: "POST", body: JSON.stringify(input) }));
}

export async function createDetailPagePairVariant(projectId: string, pairId: string, input: { revision: number; kind: "retry" | "result_retry" | "mask_edit"; mode: "remote" | "personal"; model?: string; channelId?: string; sourceMediaId?: string; maskMediaId?: string; prompt?: string; clientRequestId?: string }): Promise<{ project: DetailPageProject; variantId: string }> {
    const payload = await serverApi<{ item?: ProjectResponse; variantId?: string }>(`/api/detail-page-projects/${projectId}/pairs/${pairId}/variants`, { method: "POST", body: JSON.stringify(input) });
    return { project: unwrapProject(payload), variantId: payload.variantId || "" };
}

export async function setDetailPagePairVariantResult(projectId: string, pairId: string, variantId: string, input: { revision: number; status: "succeeded" | "failed" | "interrupted"; mediaId?: string; error?: string }): Promise<DetailPageProject> {
    return unwrapProject(await serverApi<{ item?: ProjectResponse }>(`/api/detail-page-projects/${projectId}/pairs/${pairId}/variants/${variantId}/result`, { method: "POST", body: JSON.stringify(input) }));
}

export async function promoteDetailPagePairVariant(projectId: string, pairId: string, variantId: string, revision: number): Promise<DetailPageProject> {
    return unwrapProject(await serverApi<{ item?: ProjectResponse }>(`/api/detail-page-projects/${projectId}/pairs/${pairId}/variants/${variantId}/promote`, { method: "POST", body: JSON.stringify({ revision }) }));
}

export async function cancelDetailPagePairVariant(projectId: string, pairId: string, variantId: string): Promise<DetailPageProject> {
    return unwrapProject(await serverApi<{ item?: ProjectResponse }>(`/api/detail-page-projects/${projectId}/pairs/${pairId}/variants/${variantId}/cancel`, { method: "POST", body: "{}" }));
}

export async function deleteDetailPagePairVariant(projectId: string, pairId: string, variantId: string): Promise<void> {
    await serverApi(`/api/detail-page-projects/${projectId}/pairs/${pairId}/variants/${variantId}`, { method: "DELETE" });
}

export async function cancelDetailPagePair(projectId: string, pairId: string, input: { revision: number }): Promise<DetailPageProject> {
    return unwrapProject(await serverApi<{ item?: ProjectResponse } | ProjectResponse>(`/api/detail-page-projects/${projectId}/pairs/${pairId}/cancel`, { method: "POST", body: JSON.stringify(input) }));
}

export async function deleteDetailPageProject(id: string, revision?: number): Promise<void> {
    await serverApi(`/api/detail-page-projects/${id}`, { method: "DELETE", ...(revision == null ? {} : { body: JSON.stringify({ revision }) }) });
}

import { serverApi } from "@/services/server-api";
import { useOwnerScopeStore } from "@/stores/use-owner-scope-store";
import type { DetailPageMedia, DetailPageTemplate, DetailPageTemplateListQuery, DetailPageTemplateListResponse, DetailPageTemplateReference } from "@/types/detail-page";

type MediaResponse = Partial<DetailPageMedia> & { id?: string; mediaId?: string };
type ReferenceResponse = Partial<DetailPageTemplateReference> & { image?: MediaResponse };
type TemplateResponse = Partial<DetailPageTemplate> & { coverImage?: MediaResponse; references?: ReferenceResponse[] };

function normalizeMedia(media?: MediaResponse): DetailPageMedia {
    const mediaId = media?.mediaId || media?.id || "";
    return { id: media?.id || mediaId, mediaId, fileName: media?.fileName || "媒体文件", mimeType: media?.mimeType || "image/png", bytes: Number(media?.bytes || 0), url: media?.url || "", thumbnailUrl: media?.thumbnailUrl || media?.url || "", storageKey: media?.storageKey || (mediaId ? `media:${mediaId}` : ""), width: media?.width == null ? undefined : Number(media.width), height: media?.height == null ? undefined : Number(media.height) };
}

function normalizeReference(raw: ReferenceResponse, index: number): DetailPageTemplateReference {
    return { id: raw.id || "", mediaId: raw.mediaId || raw.image?.mediaId || raw.image?.id || "", sortOrder: Number.isInteger(raw.sortOrder) ? Number(raw.sortOrder) : index, image: normalizeMedia(raw.image), createdAt: raw.createdAt || "" };
}

function normalizeTemplate(raw: TemplateResponse): DetailPageTemplate {
    const references = (Array.isArray(raw.references) ? raw.references : []).map(normalizeReference).sort((a, b) => a.sortOrder - b.sortOrder);
    const coverImage = raw.coverImage ? normalizeMedia(raw.coverImage) : references[0]?.image;
    return { id: raw.id || "", ownerId: raw.ownerId || "", ownerUsername: raw.ownerUsername || "", name: raw.name || "", coverImage, references, referenceCount: Number(raw.referenceCount ?? references.length), revision: Number(raw.revision || 1), accessLevel: raw.accessLevel as DetailPageTemplate["accessLevel"], createdAt: raw.createdAt || "", updatedAt: raw.updatedAt || "" };
}

function unwrap(payload: { item?: TemplateResponse } | TemplateResponse) {
    return normalizeTemplate("item" in payload && payload.item ? payload.item : payload);
}

function assertReferences(ids: string[]) {
    if (ids.length < 1 || ids.length > 18) throw new Error("详情页模板参考图数量必须为 1-18 张");
    if (new Set(ids).size !== ids.length) throw new Error("详情页模板参考图不能重复");
}

export async function listDetailPageTemplates(query: DetailPageTemplateListQuery = {}): Promise<DetailPageTemplateListResponse> {
    const params = new URLSearchParams({ owner: query.owner || useOwnerScopeStore.getState().scope, page: String(query.page || 1), pageSize: String(query.pageSize || 24) });
    if (query.keyword?.trim()) params.set("keyword", query.keyword.trim());
    const result = await serverApi<{ items: TemplateResponse[]; total: number; page: number; pageSize: number }>(`/api/detail-page-templates?${params}`);
    return { ...result, items: (result.items || []).map(normalizeTemplate) };
}

export async function getDetailPageTemplate(id: string) {
    return unwrap(await serverApi<{ item?: TemplateResponse } | TemplateResponse>(`/api/detail-page-templates/${id}`));
}

export async function createDetailPageTemplate(input: { ownerId?: string; name: string; referenceMediaIds: string[] }) {
    assertReferences(input.referenceMediaIds);
    return unwrap(await serverApi<{ item?: TemplateResponse } | TemplateResponse>("/api/detail-page-templates", { method: "POST", body: JSON.stringify(input) }));
}

export async function updateDetailPageTemplate(id: string, input: { revision: number; name?: string; referenceMediaIds?: string[] }) {
    if (input.referenceMediaIds) assertReferences(input.referenceMediaIds);
    return unwrap(await serverApi<{ item?: TemplateResponse } | TemplateResponse>(`/api/detail-page-templates/${id}`, { method: "PATCH", body: JSON.stringify(input) }));
}

export async function deleteDetailPageTemplate(id: string, revision: number) {
    await serverApi(`/api/detail-page-templates/${id}`, { method: "DELETE", body: JSON.stringify({ revision }) });
}

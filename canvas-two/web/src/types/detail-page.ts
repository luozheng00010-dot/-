import type { AccessLevel, OwnerScope } from "@/stores/use-owner-scope-store";

export type DetailPageProjectStatus = "draft" | "generating" | "partial" | "succeeded" | "failed";
export type DetailPagePairStatus = "draft" | "queued" | "running" | "succeeded" | "failed" | "interrupted";
export type DetailPagePairVariantKind = "retry" | "result_retry" | "mask_edit" | "previous_main";
export type DetailPagePairVariantStatus = "draft" | "queued" | "running" | "succeeded" | "failed" | "interrupted";

export type DetailPageMedia = {
    id: string;
    mediaId: string;
    fileName: string;
    mimeType: string;
    bytes: number;
    url: string;
    thumbnailUrl: string;
    storageKey: string;
    width?: number;
    height?: number;
};

export type DetailPageProduct = {
    id: string;
    name: string;
    brand: string;
    productType: string;
    material: string;
    sellingPoints: string[];
    instruction: string;
    resultImage?: DetailPageMedia;
};

export type DetailPagePair = {
    id: string;
    projectId: string;
    sortOrder: number;
    referenceMediaId: string;
    referenceImage: DetailPageMedia;
    resultMediaId?: string;
    resultImage?: DetailPageMedia;
    referenceWidth: number;
    referenceHeight: number;
    prompt: string;
    generationModel?: string;
    generationChannelId?: string;
    generationResolution: "1k" | "2k" | "4k";
    generationAspectRatio: "original" | "1:1" | "3:2" | "2:3" | "16:9" | "9:16" | "4:3" | "3:4" | "21:9";
    generationQuality: "auto" | "low" | "medium" | "high";
    resolvedPrompt?: string;
    status: DetailPagePairStatus;
    activeTaskId?: string;
    error?: string;
    revision: number;
    updatedAt?: string;
    modificationVariants: DetailPagePairVariant[];
    references: DetailPagePairReference[];
};

export type DetailPagePairReference = {
    id: string;
    mediaId: string;
    kind: "original" | "result" | "upload";
    selected: boolean;
    sortOrder: number;
    image: DetailPageMedia;
};

export type DetailPagePairVariant = {
    id: string;
    pairId: string;
    mediaId?: string;
    image?: DetailPageMedia;
    sourceMediaId?: string;
    kind: DetailPagePairVariantKind;
    status: DetailPagePairVariantStatus;
    prompt: string;
    resolvedPrompt?: string;
    activeTaskId?: string;
    error?: string;
    revision: number;
    createdAt: string;
    updatedAt: string;
};

export type DetailPageProject = {
    id: string;
    ownerId: string;
    ownerUsername: string;
    productId: string;
    productMediaId: string;
    product: DetailPageProduct;
    productImage: DetailPageMedia;
    title: string;
    pairs: DetailPagePair[];
    status: DetailPageProjectStatus;
    error?: string;
    revision: number;
    accessLevel: AccessLevel;
    createdAt: string;
    updatedAt: string;
};

export type DetailPageListQuery = { owner?: OwnerScope; keyword?: string; page?: number; pageSize?: number };
export type DetailPageListResponse = { items: DetailPageProject[]; total: number; page: number; pageSize: number };

export type DetailPageTemplateReference = {
    id: string;
    mediaId: string;
    sortOrder: number;
    image: DetailPageMedia;
    createdAt: string;
};

export type DetailPageTemplate = {
    id: string;
    ownerId: string;
    ownerUsername: string;
    name: string;
    coverImage?: DetailPageMedia;
    references: DetailPageTemplateReference[];
    referenceCount: number;
    revision: number;
    accessLevel: AccessLevel | null;
    createdAt: string;
    updatedAt: string;
};

export type DetailPageTemplateListQuery = { owner?: OwnerScope; keyword?: string; page?: number; pageSize?: number };
export type DetailPageTemplateListResponse = { items: DetailPageTemplate[]; total: number; page: number; pageSize: number };

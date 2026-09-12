import type { AccessLevel, OwnerScope } from "@/stores/use-owner-scope-store";

export type ProductStatus = "draft" | "queued" | "running" | "succeeded" | "failed";

export type ProductMedia = {
    id: string;
    mediaId: string;
    role: "source" | "result";
    sortOrder: number;
    fileName: string;
    mimeType: string;
    bytes: number;
    url: string;
    thumbnailUrl: string;
    storageKey: string;
};

export type Product = {
    id: string;
    name: string;
    brand: string;
    productType: string;
    sellingPoints: string[];
    material: string;
    instruction: string;
    status: ProductStatus;
    error?: string;
    activeTaskId?: string;
    revision: number;
    ownerId: string;
    ownerUsername: string;
    createdByUsername: string;
    updatedByUsername: string;
    accessLevel: AccessLevel;
    sourceImages: ProductMedia[];
    resultImage?: ProductMedia;
    createdAt: string;
    updatedAt: string;
};

export type ProductListResponse = {
    items: Product[];
    total: number;
    page: number;
    pageSize: number;
};

export type ProductListQuery = {
    owner?: OwnerScope;
    keyword?: string;
    page?: number;
    pageSize?: number;
};

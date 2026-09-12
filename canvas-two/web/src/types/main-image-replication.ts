import type { AccessLevel, OwnerScope } from "@/stores/use-owner-scope-store";

export type MainImageReplicationStatus = "draft" | "generating" | "partial" | "succeeded" | "failed";
export type MainImageReplicationPairStatus = "draft" | "queued" | "running" | "succeeded" | "failed" | "interrupted";
export type MainImageReplicationVariantKind = "retry" | "mask_edit" | "previous_main";
export type MainImageReplicationVariantStatus = "draft" | "queued" | "running" | "succeeded" | "failed" | "interrupted";
export type MainImageMedia = { id: string; mediaId: string; fileName: string; mimeType: string; bytes: number; url: string; thumbnailUrl: string; storageKey: string; width?: number; height?: number };
export type MainImageProduct = { id: string; name: string; brand: string; productType: string; material: string; sellingPoints: string[]; instruction: string; resultImage?: MainImageMedia };
export type MainImageVariant = { id: string; pairId: string; mediaId?: string; image?: MainImageMedia; sourceMediaId?: string; kind: MainImageReplicationVariantKind; status: MainImageReplicationVariantStatus; prompt: string; resolvedPrompt?: string; activeTaskId?: string; error?: string; revision: number; createdAt: string; updatedAt: string };
export type MainImagePair = { id: string; projectId: string; sortOrder: number; referenceMediaId: string; referenceImage: MainImageMedia; resultMediaId?: string; resultImage?: MainImageMedia; referenceWidth: number; referenceHeight: number; prompt: string; resolvedPrompt?: string; status: MainImageReplicationPairStatus; activeTaskId?: string; error?: string; revision: number; modificationVariants: MainImageVariant[] };
export type MainImageProject = { id: string; ownerId: string; ownerUsername: string; title: string; productId: string; productMediaId: string; product: MainImageProduct; productImage: MainImageMedia; pairs: MainImagePair[]; status: MainImageReplicationStatus; error?: string; revision: number; defaultPrompt: string; accessLevel: AccessLevel; createdAt: string; updatedAt: string };
export type MainImageTemplate = { id: string; ownerId: string; ownerUsername?: string; name: string; revision: number; referenceCount: number; coverImage?: MainImageMedia; references: Array<{ id: string; mediaId: string; sortOrder: number; image?: MainImageMedia }>; accessLevel: AccessLevel; createdAt: string; updatedAt: string };
export type MainImageProjectQuery = { owner?: OwnerScope; keyword?: string; page?: number; pageSize?: number };

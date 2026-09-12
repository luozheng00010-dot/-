import { serverApi } from "@/services/server-api";
import { selectedOwnerId, useOwnerScopeStore } from "@/stores/use-owner-scope-store";
import type { Product, ProductListQuery, ProductListResponse, ProductStatus } from "@/types/product";

function normalizeProduct(product: Product): Product {
    return {
        ...product,
        brand: product.brand || "",
        productType: product.productType || "",
        sellingPoints: Array.isArray(product.sellingPoints) ? product.sellingPoints : [],
        material: product.material || "",
        sourceImages: Array.isArray(product.sourceImages) ? product.sourceImages : [],
    };
}

export async function listProducts(query: ProductListQuery = {}) {
    const params = new URLSearchParams({
        owner: query.owner || useOwnerScopeStore.getState().scope,
        page: String(query.page || 1),
        pageSize: String(query.pageSize || 24),
    });
    if (query.keyword?.trim()) params.set("keyword", query.keyword.trim());
    const result = await serverApi<ProductListResponse>(`/api/products?${params.toString()}`);
    return { ...result, items: result.items.map(normalizeProduct) };
}

export async function listAllProducts(query: Omit<ProductListQuery, "page" | "pageSize"> = {}) {
    const pageSize = 50;
    const items: Product[] = [];
    let page = 1;
    let total = 0;
    do {
        const result = await listProducts({ ...query, page, pageSize });
        items.push(...result.items);
        total = result.total;
        page += 1;
    } while (items.length < total && page <= 100);
    return { items, total: items.length };
}

export async function getProduct(id: string) {
    return normalizeProduct((await serverApi<{ item: Product }>(`/api/products/${id}`)).item);
}

export async function createProduct(input: { name: string; brand?: string; productType: string; sellingPoints?: string[]; material?: string; instruction?: string; sourceMediaIds: string[] }) {
    return normalizeProduct((await serverApi<{ item: Product }>("/api/products", {
        method: "POST",
        body: JSON.stringify({ ...input, ownerId: selectedOwnerId() }),
    })).item);
}

export async function updateProduct(id: string, input: { revision: number; name?: string; brand?: string; productType?: string; sellingPoints?: string[]; material?: string; instruction?: string; sourceMediaIds?: string[] }) {
    return normalizeProduct((await serverApi<{ item: Product }>(`/api/products/${id}`, { method: "PATCH", body: JSON.stringify(input) })).item);
}

export async function setProductGenerationResult(id: string, input: { status: Extract<ProductStatus, "running" | "succeeded" | "failed">; mediaId?: string; error?: string }) {
    return normalizeProduct((await serverApi<{ item: Product }>(`/api/products/${id}/result`, { method: "POST", body: JSON.stringify(input) })).item);
}

export async function deleteProduct(id: string) {
    await serverApi(`/api/products/${id}`, { method: "DELETE" });
}

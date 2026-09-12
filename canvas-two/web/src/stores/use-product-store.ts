import { create } from "zustand";

import { listProducts } from "@/services/products";
import type { OwnerScope } from "@/stores/use-owner-scope-store";
import type { Product } from "@/types/product";

type ProductStore = {
    items: Product[];
    total: number;
    loading: boolean;
    error: string;
    load: (query: { owner: OwnerScope; keyword: string; page: number; pageSize: number }) => Promise<void>;
    upsert: (product: Product) => void;
    remove: (id: string) => void;
};

let loadVersion = 0;

export const useProductStore = create<ProductStore>((set) => ({
    items: [],
    total: 0,
    loading: false,
    error: "",
    load: async (query) => {
        const version = ++loadVersion;
        set({ loading: true, error: "" });
        try {
            const result = await listProducts(query);
            if (version !== loadVersion) return;
            set({ items: result.items, total: result.total, loading: false });
        } catch (error) {
            if (version !== loadVersion) return;
            set({ loading: false, error: error instanceof Error ? error.message : "商品读取失败" });
        }
    },
    upsert: (product) => set((state) => ({ items: [product, ...state.items.filter((item) => item.id !== product.id)] })),
    remove: (id) => set((state) => ({ items: state.items.filter((item) => item.id !== id), total: Math.max(0, state.total - 1) })),
}));

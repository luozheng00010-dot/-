import { z } from "zod";

export const libraryName = z.object({ name: z.string().trim().min(1, "请输入名称").max(100) });
export const nameKey = (name: string) => name.trim().replace(/[A-Z]/g, (letter) => letter.toLowerCase());
export const materialAssignment = z.object({ skuId: z.string().uuid(), categoryId: z.string().uuid() });
export const localSelection = z.object({
    localSkuId: z.string().uuid("请选择货号"),
    localCategoryIds: z.array(z.string().uuid()).min(1, "请选择分类").transform((ids) => [...new Set(ids)]),
});
export function selectionWhere(input: z.infer<typeof localSelection>) {
    return { skuId: input.localSkuId, categoryId: { in: input.localCategoryIds }, deletedAt: null };
}

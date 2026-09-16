import { Router } from "express";
import { z } from "zod";
import { requireReadyUser } from "../access.js";
import { prisma } from "../db.js";

/**
 * 自动剪辑 · 货号管理接口。
 * 货号是一等数据，先建后用：上传素材（routes-materials）与创建文案（routes-scripts）时
 * sku 必须已存在于 video_skus，否则 400。
 * "通用"是通用素材分类的哨兵值（D3），不参与货号管理：不能增删、不出现在列表里。
 * 鉴权与响应风格同 routes-materials.ts（requireReadyUser）。
 */

const router = Router();
router.use(requireReadyUser);

const routeParam = (value: string | string[]) => Array.isArray(value) ? value[0] : value;

function skuDto(sku: { id: string; name: string; createdAt: Date }, materialCount = 0) {
    return { id: sku.id, name: sku.name, materialCount, createdAt: sku.createdAt };
}

// ===== 列表 =====

router.get("/skus", async (_req, res) => {
    // materialCount 只统计未归档素材（归档不参与匹配，删除保护才需要含归档总数）
    const [skus, counts] = await Promise.all([
        prisma.videoSku.findMany({ orderBy: { createdAt: "desc" } }),
        prisma.videoMaterial.groupBy({ by: ["sku"], where: { status: { not: "archived" } }, _count: { _all: true } }),
    ]);
    const countBySku = new Map(counts.map((row) => [row.sku, row._count._all]));
    res.json({ skus: skus.map((sku) => skuDto(sku, countBySku.get(sku.name) ?? 0)) });
});

// ===== 新增 =====

const skuCreateInput = z.object({
    name: z.string({ required_error: "请填写货号" }).trim().min(1, "请填写货号").max(100, "货号最长 100 字"),
});

router.post("/skus", async (req, res) => {
    const input = skuCreateInput.parse(req.body || {});
    if (input.name === "通用") throw Object.assign(new Error("通用为系统保留，无需添加"), { status: 400 });
    const existing = await prisma.videoSku.findUnique({ where: { name: input.name } });
    if (existing) throw Object.assign(new Error("货号已存在"), { status: 400 });
    const sku = await prisma.videoSku.create({ data: { name: input.name } });
    res.status(201).json({ sku: skuDto(sku) });
});

// ===== 删除 =====

router.delete("/skus/:id", async (req, res) => {
    const sku = await prisma.videoSku.findUnique({ where: { id: routeParam(req.params.id) } });
    if (!sku) throw Object.assign(new Error("货号不存在"), { status: 404 });
    // 服务端兜底校验：只要还有视频素材（含归档）就禁止删除
    const materialCount = await prisma.videoMaterial.count({ where: { sku: sku.name } });
    if (materialCount > 0) throw Object.assign(new Error(`该货号下还有 ${materialCount} 条视频素材，无法删除`), { status: 400 });
    await prisma.videoSku.delete({ where: { id: sku.id } });
    res.json({ ok: true });
});

export default router;

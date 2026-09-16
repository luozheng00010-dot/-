import { Router } from "express";
import { z } from "zod";
import { requireReadyUser } from "../access.js";
import { prisma } from "../db.js";

/**
 * 自动剪辑 · 分类管理接口（P2 F6）。
 * 新建自定义分类（"通用"与系统分类名保留）；停用=软删（enabled=false，不物理删除，
 * 已有素材/批次引用保留）；系统分类（isSystem=true，含"通用"）一律不可改不可删。
 * 停用后的分类不出现在上传表单与拆句 prompt（见 routes-materials.ts / split.ts 的过滤）。
 * 鉴权与响应风格同 routes-materials.ts（requireReadyUser）。
 */

const router = Router();
router.use(requireReadyUser);

const routeParam = (value: string | string[]) => Array.isArray(value) ? value[0] : value;

function categoryDto(category: { id: string; name: string; isSystem: boolean; sortOrder: number; enabled: boolean }) {
    return { id: category.id, name: category.name, isSystem: category.isSystem, sortOrder: category.sortOrder, enabled: category.enabled };
}

// ===== 新增 =====

const categoryCreateInput = z.object({
    name: z.string({ required_error: "请填写分类名" }).trim().min(1, "请填写分类名").max(30, "分类名最长 30 字"),
});

router.post("/categories", async (req, res) => {
    const input = categoryCreateInput.parse(req.body || {});
    if (input.name === "通用") throw Object.assign(new Error("\"通用\"是系统分类，不能新建同名分类"), { status: 400 });
    // 重名校验含已停用的分类（name 全局唯一，物理不删）
    const existing = await prisma.videoCategory.findUnique({ where: { name: input.name } });
    if (existing) throw Object.assign(new Error("分类已存在"), { status: 400 });
    const category = await prisma.videoCategory.create({ data: { name: input.name, isSystem: false, sortOrder: 0, enabled: true } });
    res.status(201).json({ category: categoryDto(category) });
});

// ===== 修改（改名 / 启停） =====

const categoryUpdateInput = z.object({
    name: z.string().trim().min(1, "分类名不能为空").max(30, "分类名最长 30 字").optional(),
    enabled: z.boolean().optional(),
}).refine((data) => data.name !== undefined || data.enabled !== undefined, { message: "至少传入一个要更新的字段" });

router.put("/categories/:id", async (req, res) => {
    const input = categoryUpdateInput.parse(req.body || {});
    const category = await prisma.videoCategory.findUnique({ where: { id: routeParam(req.params.id) } });
    if (!category) throw Object.assign(new Error("分类不存在"), { status: 404 });
    if (category.isSystem) throw Object.assign(new Error("系统分类不可修改"), { status: 400 });
    if (input.name !== undefined && input.name !== category.name) {
        const existing = await prisma.videoCategory.findUnique({ where: { name: input.name } });
        if (existing) throw Object.assign(new Error("分类已存在"), { status: 400 });
    }
    const updated = await prisma.videoCategory.update({
        where: { id: category.id },
        data: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        },
    });
    res.json({ category: categoryDto(updated) });
});

// ===== 删除（软删：enabled=false） =====

router.delete("/categories/:id", async (req, res) => {
    const category = await prisma.videoCategory.findUnique({ where: { id: routeParam(req.params.id) } });
    if (!category) throw Object.assign(new Error("分类不存在"), { status: 404 });
    if (category.isSystem) throw Object.assign(new Error("系统分类不可删除"), { status: 400 });
    if (!category.enabled) {
        res.json({ category: categoryDto(category) }); // 已停用：幂等返回，不重复写库
        return;
    }
    const updated = await prisma.videoCategory.update({ where: { id: category.id }, data: { enabled: false } });
    res.json({ category: categoryDto(updated) });
});

export default router;

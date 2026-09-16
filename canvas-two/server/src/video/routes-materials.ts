import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { Router, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { z } from "zod";
import { requireReadyUser } from "../access.js";
import { prisma } from "../db.js";
import { putObject, removeObject } from "../storage.js";

/**
 * 自动剪辑 · 素材批量入库接口（T4）。
 * 上传只建表不打标：MediaFile(origin=video) + VideoMaterial(pending) + VideoIngestBatch，
 * ffprobe 抽帧与 VLM 打标由 worker 进程的 ingest.ts 异步消化（D10）。
 * 鉴权与 kb 路由一致：requireReadyUser。
 */

const router = Router();
router.use(requireReadyUser);

const MAX_FILES_PER_BATCH = 100;
const MAX_FILE_SIZE_MB = 200;
const MAX_FILE_SIZE = MAX_FILE_SIZE_MB * 1024 * 1024;
const TEMP_DIR = join(tmpdir(), "video-material-ingest");
mkdirSync(TEMP_DIR, { recursive: true });

const routeParam = (value: string | string[]) => Array.isArray(value) ? value[0] : value;

/** 从原始文件名取安全的小写扩展名；无扩展名或非法时回退 mp4，保证 objectKey 形如 <uuid>.<ext> */
function safeExtension(fileName: string): string {
    const ext = extname(fileName).replace(/^\./, "").toLowerCase();
    return /^[a-z0-9]{1,10}$/.test(ext) ? ext : "mp4";
}

const upload = multer({
    storage: multer.diskStorage({
        destination: TEMP_DIR,
        filename: (_req, file, callback) => callback(null, `${randomUUID()}.${safeExtension(file.originalname)}`),
    }),
    limits: { fileSize: MAX_FILE_SIZE, files: MAX_FILES_PER_BATCH },
    fileFilter: (_req, file, callback) => {
        if (file.mimetype?.startsWith("video/")) return callback(null, true);
        callback(Object.assign(new Error(`文件 ${file.originalname || "(未命名)"} 不是视频类型（${file.mimetype || "未知 MIME"}）`), { status: 400 }));
    },
});

/** multer 中间件包装：把 LIMIT_* 错误转成中文 400；出错时清理已落盘的暂存文件 */
function acceptUpload(req: Request, res: Response, next: NextFunction): void {
    upload.array("files", MAX_FILES_PER_BATCH)(req, res, (error?: unknown) => {
        if (!error) return next();
        const files = (req as typeof req & { files?: Express.Multer.File[] }).files;
        if (files?.length) void Promise.all(files.map((file) => rm(file.path, { force: true }).catch(() => undefined)));
        const status = (error as { status?: number }).status;
        if (status) return next(error);
        const code = (error as { code?: string }).code;
        if (code === "LIMIT_FILE_SIZE") return next(Object.assign(new Error(`单个视频文件不能超过 ${MAX_FILE_SIZE_MB}MB`), { status: 400 }));
        if (code === "LIMIT_FILE_COUNT") return next(Object.assign(new Error(`单次最多上传 ${MAX_FILES_PER_BATCH} 个视频文件`), { status: 400 }));
        if (code === "LIMIT_UNEXPECTED_FILE") return next(Object.assign(new Error("文件字段名必须是 files"), { status: 400 }));
        next(error);
    });
}

const batchSummary = (batch: { id: string; sku: string; categoryId: string; totalCount: number; doneCount: number; failedCount: number; status: string }) => ({
    id: batch.id,
    sku: batch.sku,
    categoryId: batch.categoryId,
    totalCount: batch.totalCount,
    doneCount: batch.doneCount,
    failedCount: batch.failedCount,
    status: batch.status,
});

function materialItem(material: any) {
    return {
        id: material.id,
        sku: material.sku,
        categoryId: material.categoryId,
        categoryName: material.category?.name ?? null,
        fileName: material.fileName,
        duration: material.duration,
        width: material.width,
        height: material.height,
        tagStatus: material.tagStatus,
        tagError: material.tagError,
        description: material.description,
        shotType: material.shotType,
        motion: material.motion,
        productVisible: material.productVisible,
        reviewStatus: material.reviewStatus,
        status: material.status,
        createdAt: material.createdAt,
        mediaFileId: material.mediaFileId,
        thumbnailMediaId: material.thumbnailMediaId,
    };
}

// ===== 分类 =====

/** 默认只列启用分类（上传表单/拆句判定用）；管理页传 ?all=1 看全部（含停用） */
router.get("/categories", async (req, res) => {
    const includeDisabled = req.query.all === "1" || req.query.all === "true";
    const categories = await prisma.videoCategory.findMany({
        ...(includeDisabled ? {} : { where: { enabled: true } }),
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    });
    res.json({ categories: categories.map((item) => ({ id: item.id, name: item.name, isSystem: item.isSystem, sortOrder: item.sortOrder, enabled: item.enabled })) });
});

// ===== 批量上传（D10） =====

router.post("/ingest-batches", acceptUpload, async (req, res) => {
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (!files.length) throw Object.assign(new Error("请选择要上传的视频文件"), { status: 400 });
    const categoryId = z.string().uuid("categoryId 格式不正确").parse(String(req.body.categoryId ?? ""));
    const category = await prisma.videoCategory.findUnique({ where: { id: categoryId } });
    if (!category) throw Object.assign(new Error("素材分类不存在"), { status: 404 });
    if (!category.enabled) throw Object.assign(new Error("该分类已停用，请选择其他分类或联系管理员启用"), { status: 400 });
    let sku = String(req.body.sku ?? "").trim();
    if (category.name === "通用") sku = "通用"; // D3：通用分类货号强制哨兵值，忽略传入值
    sku = z.string().trim().min(1, "请填写货号").max(100, "货号最长 100 字").parse(sku);
    // 货号是一等数据，先建后用：非通用时必须已存在于 video_skus
    if (sku !== "通用") {
        const skuRow = await prisma.videoSku.findUnique({ where: { name: sku } });
        if (!skuRow) throw Object.assign(new Error("货号不存在，请先在下拉框中添加"), { status: 400 });
    }

    const batchId = randomUUID(); // 批次最后落库，但素材需要先引用它的 id
    const uploadedObjectKeys: string[] = [];
    try {
        const batch = await prisma.$transaction(async (tx) => {
            for (const file of files) {
                const buffer = await readFile(file.path);
                const objectKey = `video/materials/${randomUUID()}.${safeExtension(file.originalname)}`;
                await putObject(objectKey, buffer, file.mimetype || "video/mp4");
                uploadedObjectKeys.push(objectKey);
                const mediaFile = await tx.mediaFile.create({
                    data: {
                        ownerId: req.user!.id,
                        createdById: req.user!.id,
                        objectKey,
                        fileName: file.originalname || "video",
                        mimeType: file.mimetype || "video/mp4",
                        bytes: BigInt(file.size),
                        origin: "video",
                        visibility: "private",
                    },
                });
                await tx.videoMaterial.create({
                    data: {
                        batchId,
                        sku,
                        categoryId: category.id,
                        mediaFileId: mediaFile.id,
                        fileName: file.originalname || "video",
                        duration: 0, // ffprobe 由打标 worker 回填
                        tagStatus: "pending",
                    },
                });
            }
            return tx.videoIngestBatch.create({
                data: { id: batchId, sku, categoryId: category.id, createdById: req.user!.id, totalCount: files.length, status: "processing" },
            });
        });
        res.status(201).json({ batch: batchSummary(batch) });
    } catch (error) {
        // 入库失败时回收已上传的 MinIO 对象，避免孤儿文件
        await Promise.all(uploadedObjectKeys.map((key) => removeObject(key).catch(() => undefined)));
        throw error;
    } finally {
        await Promise.all(files.map((file) => rm(file.path, { force: true }).catch(() => undefined)));
    }
});

router.get("/ingest-batches/:id", async (req, res) => {
    const batch = await prisma.videoIngestBatch.findUnique({ where: { id: routeParam(req.params.id) } });
    if (!batch) throw Object.assign(new Error("批次不存在"), { status: 404 });
    const failedMaterials = await prisma.videoMaterial.findMany({
        where: { batchId: batch.id, tagStatus: "failed" },
        orderBy: { createdAt: "asc" },
        take: 20,
        select: { id: true, fileName: true, tagError: true },
    });
    res.json({ batch: batchSummary(batch), failedMaterials });
});

// ===== 素材列表 / 人工修正 =====

const listQuery = z.object({
    sku: z.string().trim().max(100).optional(),
    categoryId: z.string().uuid("categoryId 格式不正确").optional(),
    tagStatus: z.enum(["pending", "processing", "done", "failed"]).optional(),
    productVisible: z.enum(["true", "false"]).optional(),
    reviewStatus: z.enum(["none", "warn_confirmed", "corrected"]).optional(), // P2 复核队列：none=待复核 / warn_confirmed=已确认安全 / corrected=已改判
    keyword: z.string().trim().max(100).optional(),
    status: z.enum(["active", "archived"]).default("active"),
    ids: z.string().trim().max(10_000).optional(), // 200 个 uuid 连逗号约 7.4k 字符
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100, "每页最多 100 条").default(24),
});

router.get("/materials", async (req, res) => {
    const query = listQuery.parse(req.query);
    let ids: string[] | undefined;
    if (query.ids !== undefined && query.ids !== "") {
        ids = z.array(z.string().uuid("ids 中包含格式不正确的 id"))
            .max(200, "ids 参数一次最多 200 个")
            .parse([...new Set(query.ids.split(",").map((item) => item.trim()).filter(Boolean))]);
    }
    // ids 优先于其他过滤条件
    const where = ids ? { id: { in: ids } } : {
        ...(query.sku ? { sku: { contains: query.sku, mode: "insensitive" as const } } : {}),
        ...(query.categoryId ? { categoryId: query.categoryId } : {}),
        ...(query.tagStatus ? { tagStatus: query.tagStatus } : {}),
        ...(query.productVisible !== undefined ? { productVisible: query.productVisible === "true" } : {}),
        ...(query.reviewStatus ? { reviewStatus: query.reviewStatus } : {}),
        ...(query.keyword ? { OR: [{ description: { contains: query.keyword, mode: "insensitive" as const } }, { fileName: { contains: query.keyword, mode: "insensitive" as const } }] } : {}),
        status: query.status,
    };
    const [total, materials] = await Promise.all([
        prisma.videoMaterial.count({ where }),
        prisma.videoMaterial.findMany({
            where,
            include: { category: { select: { name: true } } },
            orderBy: { createdAt: "desc" },
            skip: (query.page - 1) * query.pageSize,
            take: query.pageSize,
        }),
    ]);
    res.json({ total, items: materials.map(materialItem) });
});

// ===== 缺口统计（P2 F5） =====

const round1 = (value: number) => Math.round(value * 10) / 10;

/** 货号 × 分类矩阵：只统计 active 且打标完成的素材（参与匹配的真实可用量），补拍清单的数据源 */
router.get("/materials/stats", async (_req, res) => {
    const [groups, categories] = await Promise.all([
        prisma.videoMaterial.groupBy({
            by: ["sku", "categoryId"],
            where: { status: "active", tagStatus: "done" },
            _count: { _all: true },
            _sum: { duration: true },
        }),
        prisma.videoCategory.findMany({ select: { id: true, name: true } }),
    ]);
    const nameById = new Map(categories.map((item) => [item.id, item.name]));
    const rows = groups
        .map((group) => ({
            sku: group.sku,
            categoryId: group.categoryId,
            categoryName: nameById.get(group.categoryId) ?? "",
            count: group._count._all,
            seconds: round1(group._sum.duration ?? 0),
        }))
        .sort((a, b) => a.sku === b.sku
            ? (a.categoryName < b.categoryName ? -1 : a.categoryName > b.categoryName ? 1 : 0)
            : (a.sku < b.sku ? -1 : 1));
    res.json({ rows });
});

// ===== 批量重打标（P2 F4 复核队列） =====

const retagInput = z.object({
    ids: z.array(z.string().uuid("ids 中包含格式不正确的 id")).min(1, "请选择要重打标的素材").max(200, "一次最多重打标 200 条素材"),
});

/** 把选中素材 tagStatus 重置 pending、清掉 tagError，打标 worker（ingest.ts）会重新消费；不存在的 id 自动忽略 */
router.post("/materials/retag", async (req, res) => {
    const input = retagInput.parse(req.body || {});
    const result = await prisma.videoMaterial.updateMany({
        where: { id: { in: input.ids } },
        data: { tagStatus: "pending", tagError: null },
    });
    res.json({ queued: result.count });
});

const patchInput = z.object({
    categoryId: z.string().uuid("categoryId 格式不正确").optional(),
    description: z.string().trim().max(500, "画面描述最长 500 字").optional(),
    shotType: z.string().trim().max(30, "景别最长 30 字").optional(),
    motion: z.string().trim().max(30, "动作最长 30 字").optional(),
    productVisible: z.boolean().optional(),
    reviewStatus: z.enum(["none", "warn_confirmed", "corrected"]).optional(),
    status: z.enum(["active", "archived"]).optional(),
}).refine((data) => Object.values(data).some((value) => value !== undefined), { message: "至少传入一个要更新的字段" });

router.patch("/materials/:id", async (req, res) => {
    const input = patchInput.parse(req.body || {});
    if (input.categoryId) {
        const category = await prisma.videoCategory.findUnique({ where: { id: input.categoryId } });
        if (!category) throw Object.assign(new Error("所选分类不存在"), { status: 400 });
        if (!category.enabled) throw Object.assign(new Error("该分类已停用，请选择其他分类或联系管理员启用"), { status: 400 });
    }
    const current = await prisma.videoMaterial.findUnique({ where: { id: routeParam(req.params.id) } });
    if (!current) throw Object.assign(new Error("素材不存在"), { status: 404 });
    const material = await prisma.videoMaterial.update({
        where: { id: current.id },
        data: {
            ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(input.shotType !== undefined ? { shotType: input.shotType } : {}),
            ...(input.motion !== undefined ? { motion: input.motion } : {}),
            ...(input.productVisible !== undefined ? { productVisible: input.productVisible } : {}),
            ...(input.reviewStatus !== undefined ? { reviewStatus: input.reviewStatus } : {}),
            ...(input.status !== undefined ? { status: input.status } : {}),
        },
        include: { category: { select: { name: true } } },
    });
    res.json({ material: materialItem(material) });
});

export default router;

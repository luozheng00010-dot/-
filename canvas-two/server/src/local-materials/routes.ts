import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { requireReadyUser } from "../access.js";
import { prisma } from "../db.js";
import { forwardStream, uploadEngineFile, removeEngineUpload } from "../auto-video/engine.js";
import { libraryName, materialAssignment, nameKey } from "./input.js";
import { materialSemanticRouter, queueMaterialAnalysis } from "./semantic-routes.js";

export const localMaterialRouter = Router();
localMaterialRouter.use(requireReadyUser);
localMaterialRouter.use(materialSemanticRouter);
const fail = (message: string, status = 400) => Object.assign(new Error(message), { status });
const idInput = z.string().uuid();
const include = { sku: true, category: true, uploadedBy: { select: { username: true } } };
const response = (item: any) => {
    const { fileKey: _key, embedding: _embedding, embeddingKey: _embeddingKey, ...visible } = item;
    return visible;
};

for (const kind of ["skus", "categories"] as const) {
    const label = kind === "skus" ? "货号" : "分类";
    localMaterialRouter.get(`/${kind}`, async (_req, res) => {
        const rows = kind === "skus"
            ? await prisma.localVideoSku.findMany({ orderBy: { nameKey: "asc" } })
            : await prisma.localVideoCategory.findMany({ orderBy: { nameKey: "asc" } });
        res.json(rows);
    });
    localMaterialRouter.post(`/${kind}`, async (req, res) => {
        const { name } = libraryName.parse(req.body);
        const data = { name, nameKey: nameKey(name) };
        try {
            res.status(201).json(kind === "skus" ? await prisma.localVideoSku.create({ data }) : await prisma.localVideoCategory.create({ data }));
        } catch (error) {
            if ((error as { code?: string }).code === "P2002") throw fail(`${label}已存在`, 409);
            throw error;
        }
    });
    localMaterialRouter.patch(`/${kind}/:id`, async (req, res) => {
        const id = idInput.parse(req.params.id);
        const { name } = libraryName.parse(req.body);
        const data = { name, nameKey: nameKey(name) };
        try {
            res.json(kind === "skus" ? await prisma.localVideoSku.update({ where: { id }, data }) : await prisma.localVideoCategory.update({ where: { id }, data }));
        } catch (error) {
            if ((error as { code?: string }).code === "P2002") throw fail(`${label}已存在`, 409);
            throw error;
        }
    });
    localMaterialRouter.delete(`/${kind}/:id`, async (req, res) => {
        const id = idInput.parse(req.params.id);
        try {
            if (kind === "skus") await prisma.localVideoSku.delete({ where: { id } });
            else await prisma.localVideoCategory.delete({ where: { id } });
        } catch (error) {
            if ((error as { code?: string }).code === "P2003") throw fail(`请先删除或调整该${label}下的素材`, 409);
            throw error;
        }
        res.json({ ok: true });
    });
}

localMaterialRouter.get("/available-categories", async (req, res) => {
    const skuId = idInput.parse(req.query.skuId);
    res.json(await prisma.localVideoCategory.findMany({
        where: { materials: { some: { skuId, deletedAt: null } } }, orderBy: { nameKey: "asc" },
    }));
});
localMaterialRouter.get("/", async (req, res) => {
    const input = z.object({
        skuId: idInput.optional(), categoryIds: z.string().optional(), search: z.string().max(100).optional(),
        page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20),
    }).parse(req.query);
    const ids = input.categoryIds ? z.array(idInput).parse(input.categoryIds.split(",")) : undefined;
    const where = {
        deletedAt: null, skuId: input.skuId, categoryId: ids ? { in: ids } : undefined,
        sku: input.search ? { name: { contains: input.search, mode: "insensitive" as const } } : undefined,
    };
    const [items, total] = await prisma.$transaction([
        prisma.localVideoMaterial.findMany({ where, include, orderBy: [{ createdAt: "asc" }, { id: "asc" }], skip: (input.page - 1) * input.pageSize, take: input.pageSize }),
        prisma.localVideoMaterial.count({ where }),
    ]);
    res.json({ items: items.map(response), total });
});

// 浏览器 multipart 文件名使用 UTF-8；在解析阶段解码，转发和入库共用原始名称。
const upload = multer({ defParamCharset: "utf8", storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 }, fileFilter: (_req, file, done) => {
    if (!/\.(mp4|mov|avi|flv|mkv|webm)$/i.test(file.originalname)) return done(fail("仅支持 MP4、MOV、AVI、FLV、MKV、WebM 视频"));
    done(null, true);
} });
localMaterialRouter.post("/upload", (req, res, next) => {
    upload.single("file")(req, res, (error) => next(error instanceof multer.MulterError ? fail(error.code === "LIMIT_FILE_SIZE" ? "视频不能超过 200 MB" : "上传文件无效") : error));
}, async (req, res) => {
    const assignment = materialAssignment.parse(req.body);
    const notes = z.string().trim().max(500, "备注不能超过 500 字").optional().parse(req.body.notes ?? undefined) || null;
    if (!req.file) throw fail("请选择视频文件");
    await Promise.all([
        prisma.localVideoSku.findUniqueOrThrow({ where: { id: assignment.skuId } }),
        prisma.localVideoCategory.findUniqueOrThrow({ where: { id: assignment.categoryId } }),
    ]);
    const fileKey = await uploadEngineFile(req.file);
    let item;
    try {
        item = await prisma.localVideoMaterial.create({ data: {
            ...assignment, fileKey, fileName: req.file.originalname, bytes: req.file.size, notes, uploadedById: req.user!.id,
        }, include });
    } catch (error) {
        await removeEngineUpload(fileKey).catch(() => console.error("本地素材入库失败，待清理文件：", fileKey));
        throw fail("素材入库失败，请刷新货号和分类后重试", 500);
    }
    // Queue failure must not delete a successfully registered video.
    const materialId = item.id;
    await prisma.$transaction((tx) => queueMaterialAnalysis(materialId, tx)).catch(async () => {
        await prisma.localVideoMaterial.update({ where: { id: materialId }, data: { analysisStatus: "failed", analysisError: "上传成功，分析排队失败，请重试分析" } }).catch(() => undefined);
    });
    const current = await prisma.localVideoMaterial.findUnique({ where: { id: materialId }, include }).catch(() => null);
    res.status(201).json(response(current ?? item));
});
localMaterialRouter.patch("/:id", async (req, res) => {
    const id = idInput.parse(req.params.id);
    const data = materialAssignment.parse(req.body);
    try {
        res.json(response(await prisma.localVideoMaterial.update({ where: { id, deletedAt: null }, data, include })));
    } catch (error) {
        if ((error as { code?: string }).code === "P2003") throw fail("货号或分类已不存在，请刷新后重试", 409);
        throw error;
    }
});
localMaterialRouter.delete("/:id", async (req, res) => {
    await prisma.localVideoMaterial.update({ where: { id: idInput.parse(req.params.id), deletedAt: null }, data: {
        deletedAt: new Date(), skuId: null, categoryId: null,
    } });
    res.json({ ok: true });
});
localMaterialRouter.get("/:id/preview", async (req, res) => {
    const item = await prisma.localVideoMaterial.findFirstOrThrow({ where: { id: idInput.parse(req.params.id), deletedAt: null } });
    await forwardStream(req, res, `/api/v1/library-videos/${encodeURIComponent(item.fileKey)}`);
});

import { randomUUID } from "node:crypto";
import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db.js";
import { enqueue, json } from "../auto-video/semantic-queue.js";
import { annotationInput, fail } from "../auto-video/semantic-types.js";
import { embeddingIdentity } from "../auto-video/semantic-models.js";

export const materialSemanticRouter = Router();
const uuid = z.string().uuid();
export async function queueMaterialAnalysis(materialId: string, tx: any = prisma) {
    const material = await tx.localVideoMaterial.findFirst({ where: { id: materialId, deletedAt: null } });
    if (!material) throw fail("素材不存在", 404);
    const active = await tx.autoVideoJob.findFirst({ where: { targetId: materialId, kind: { in: ["analyze", "index"] }, status: { in: ["queued", "running"] } } });
    if (active) return active;
    const updated = await tx.localVideoMaterial.update({ where: { id: materialId }, data: { revision: { increment: 1 }, analysisStatus: "queued", analysisError: null, indexedRevision: null } });
    return enqueue("analyze", materialId, `analyze:${materialId}:${updated.revision}`, { revision: updated.revision }, tx);
}
materialSemanticRouter.post("/analyze", async (req, res) => {
    const ids = z.array(uuid).min(1).max(100).parse(req.body.ids);
    const jobs = [];
    for (const materialId of [...new Set(ids)]) jobs.push(await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM local_video_materials WHERE id=${materialId} FOR UPDATE`;
        return queueMaterialAnalysis(materialId, tx);
    }));
    res.status(202).json(jobs.map((j) => ({ id: j.id, status: j.status })));
});
materialSemanticRouter.get("/index-status", async (_req, res) => {
    let key: string | null = null;
    try { key = await embeddingIdentity(); } catch { /* Configuration is reported separately in admin. */ }
    const [total, ready] = await Promise.all([
        prisma.localVideoMaterial.count({ where: { deletedAt: null, disabled: false } }),
        key ? prisma.$queryRaw<{ count: bigint }[]>`SELECT COUNT(*) AS count FROM local_video_materials WHERE deleted_at IS NULL AND disabled=false AND analysis_status='ready' AND indexed_revision=revision AND embedding_key=${key}` : Promise.resolve([{ count: 0n }]),
    ]);
    res.json({ total, ready: Number(ready[0].count), configured: !!key });
});
materialSemanticRouter.patch("/:id/annotation", async (req, res) => {
    const materialId = uuid.parse(req.params.id);
    const input = z.object({ revision: z.number().int().min(0), annotation: annotationInput.optional(), acceptProposed: z.boolean().optional(), disabled: z.boolean().optional() }).parse(req.body);
    const result = await prisma.$transaction(async (tx) => {
        const old = await tx.localVideoMaterial.findFirst({ where: { id: materialId, deletedAt: null } });
        if (!old || old.revision !== input.revision) throw fail("素材版本已变化，请刷新", 409);
        const annotation = input.acceptProposed ? annotationInput.parse(old.proposedAnnotation) : input.annotation;
        if (annotation) annotation.needsReview = false;
        const changed = await tx.localVideoMaterial.updateMany({ where: { id: materialId, revision: input.revision }, data: {
            disabled: input.disabled, revision: { increment: 1 }, indexedRevision: null,
            ...(old.annotation ? { analysisStatus: "indexing" } : {}),
            ...(annotation ? { annotation: json(annotation), annotationSource: "manual", proposedAnnotation: Prisma.DbNull, analysisStatus: "indexing", analysisError: null, notes: annotation.userNotes || null } : {}),
        } });
        if (!changed.count) throw fail("素材版本冲突", 409);
        if (annotation || old.annotation) await enqueue("index", materialId, `index:${materialId}:${input.revision+1}:${randomUUID()}`, { revision: input.revision+1 }, tx);
        return { revision: input.revision+1 };
    });
    res.json(result);
});

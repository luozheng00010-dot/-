import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { forwardStream } from "./engine.js";
import { enqueue, json } from "./semantic-queue.js";
import { editInput, fail, FPS, planInput, renderOptions, validateVariant, type PlanDocument } from "./semantic-types.js";

export const semanticRouter = Router();
const id = z.string().uuid();
const version = z.number().int().positive();
async function owned(planId: unknown, userId: string, tx: any = prisma) {
    const plan = await tx.autoVideoPlan.findFirst({ where: { id: id.parse(planId), createdById: userId } });
    if (!plan) throw fail("方案不存在", 404);
    return plan;
}
function ready(plan: any, revision: number): PlanDocument {
    if (plan.revision !== revision) throw fail("方案已更新，请刷新后操作", 409);
    if (plan.status !== "ready" || !plan.document) throw fail("方案尚未完成匹配", 409);
    return structuredClone(plan.document) as PlanDocument;
}
function visible(plan: any) {
    if (!plan.document) return plan;
    const doc = structuredClone(plan.document) as PlanDocument;
    doc.units.forEach((u) => u.candidates.forEach((c) => { delete (c as any).fileKey; }));
    return { ...plan, document: doc };
}
semanticRouter.post("/plans", async (req, res) => {
    const input = planInput.parse(req.body);
    const requestId = `${req.user!.id}:${id.parse(req.body.requestId)}`;
    const result = await prisma.$transaction(async (tx) => {
        const plan = await tx.autoVideoPlan.upsert({ where: { requestId }, create: { createdById: req.user!.id, requestId, input: json(input) }, update: {} });
        if (JSON.stringify(plan.input) !== JSON.stringify(JSON.parse(JSON.stringify(input)))) {
            // JSONB key order is not significant.
            const old = planInput.parse(plan.input);
            if (JSON.stringify(old) !== JSON.stringify(input)) throw fail("请求标识已用于不同方案", 409);
        }
        await enqueue("plan", plan.id, `plan:${plan.id}:1`, { revision: 1 }, tx);
        return plan;
    });
    res.status(202).json(visible(result));
});
semanticRouter.get("/plans", async (req, res) => {
    res.json(await prisma.autoVideoPlan.findMany({ where: { createdById: req.user!.id }, select: { id: true, status: true, revision: true, createdAt: true, input: true, error: true }, orderBy: { createdAt: "desc" }, take: 100 }));
});
semanticRouter.get("/plans/:id", async (req, res) => {
    const plan = await owned(req.params.id, req.user!.id);
    const jobs = await prisma.autoVideoJob.findMany({ where: { targetId: plan.id }, orderBy: { createdAt: "desc" }, select: { id: true, kind: true, status: true, result: true, error: true, createdAt: true, dedupeKey: true } });
    res.json({ ...visible(plan), jobs: jobs.map((j) => ({ ...j, result: j.kind === "render" ? j.result : null })) });
});
semanticRouter.patch("/plans/:id", async (req, res) => {
    const revision = version.parse(req.body.revision);
    const plan = await owned(req.params.id, req.user!.id);
    const doc = ready(plan, revision);
    if (req.body.edit) {
        const edit = editInput.parse(req.body.edit);
        if (!doc.variants[edit.variant]?.[edit.unit]) throw fail("句子或成片编号无效");
        doc.variants[edit.variant][edit.unit] = { ...edit, shots: edit.shots.map((s) => ({ ...s, manual: true, frames: Math.floor((s.sourceEnd - s.sourceStart) / s.speed * FPS + 1e-6) })) };
        validateVariant(doc, doc.variants[edit.variant], false);
    } else if (req.body.options) doc.options = renderOptions.parse(req.body.options);
    else throw fail("缺少修改内容");
    const updated = await prisma.autoVideoPlan.updateMany({ where: { id: plan.id, revision, status: "ready" }, data: { document: json(doc), input: json({ ...planInput.parse(plan.input), options: doc.options }), revision: { increment: 1 } } });
    if (!updated.count) throw fail("方案版本冲突，请刷新", 409);
    res.json(visible(await owned(plan.id, req.user!.id)));
});
semanticRouter.post("/plans/:id/rematch", async (req, res) => {
    const revision = version.parse(req.body.revision);
    const record = await prisma.$transaction(async (tx) => {
        const plan = await owned(req.params.id, req.user!.id, tx);
        if (plan.revision !== revision || plan.status === "queued") throw fail("方案版本冲突或正在处理中", 409);
        let input = req.body.input ? planInput.parse(req.body.input) : planInput.parse(plan.input);
        let units = !req.body.input && req.body.units ? z.array(z.number().int().min(0)).min(1).parse(req.body.units) : undefined;
        let changedUnit: number | undefined, unitText: string | undefined;
        if (req.body.unitText !== undefined && !req.body.input) {
            changedUnit = z.number().int().min(0).parse(req.body.unit);
            unitText = z.string().min(1).max(20000).refine((s) => !!s.trim()).parse(req.body.unitText);
            const oldUnit = plan.document?.units[changedUnit];
            if (!oldUnit || plan.status !== "ready") throw fail("待修改的语义单元不存在", 409);
            input = planInput.parse({ ...input, script: input.script.slice(0, oldUnit.start) + unitText + input.script.slice(oldUnit.end) });
            units = [changedUnit];
        }
        if (units && (!plan.document || units.some((i) => i >= plan.document.units.length))) throw fail("重匹配句子无效");
        const updated = await tx.autoVideoPlan.updateMany({ where: { id: plan.id, revision }, data: { input: json(input), revision: { increment: 1 }, status: "queued", error: null } });
        if (!updated.count) throw fail("方案版本冲突", 409);
        await enqueue("plan", plan.id, `plan:${plan.id}:${revision+1}`, { revision: revision+1, ...(units ? { units: [...new Set(units)] } : {}), ...(changedUnit !== undefined ? { changedUnit, unitText } : {}) }, tx);
        return { id: plan.id, revision: revision+1, status: "queued" };
    });
    res.status(202).json(record);
});
semanticRouter.post("/plans/:id/render", async (req, res) => {
    const revision = version.parse(req.body.revision), variant = z.number().int().min(0).max(4).parse(req.body.variant);
    id.parse(req.body.requestId);
    const job = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM auto_video_plans WHERE id=${id.parse(req.params.id)} FOR UPDATE`;
        const plan = await owned(req.params.id, req.user!.id, tx);
        const doc = ready(plan, revision);
        const key = `render:${plan.id}:${revision}:${variant}`;
        const existing = await tx.autoVideoJob.findUnique({ where: { dedupeKey: key } });
        if (existing) return existing;
        if (!doc.variants[variant]) throw fail("成片编号无效");
        validateVariant(doc, doc.variants[variant]);
        const input = planInput.parse(plan.input);
        const ids = [...new Set(doc.variants[variant].flatMap((u) => u.shots.map((s) => s.materialId)))];
        // Lock selected rows until snapshot is committed. Logical deletion later cannot alter file keys.
        const { Prisma } = await import("@prisma/client");
        await tx.$queryRaw(Prisma.sql`SELECT id FROM local_video_materials WHERE id IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE`);
        const materials = await tx.localVideoMaterial.findMany({ where: { id: { in: ids }, skuId: input.skuId, categoryId: { in: input.categoryIds }, deletedAt: null, disabled: false } });
        const shots = doc.variants[variant].flatMap((unit, i) => unit.shots.map((shot) => {
            const candidate = doc.units[i].candidates.find((c) => c.id === shot.materialId)!;
            const current = materials.find((c: { id: string }) => c.id === shot.materialId);
            if (!current || current.revision !== candidate.revision || current.fileKey !== candidate.fileKey) throw fail("素材已删除、禁用或更新，请重新匹配受影响句子", 409);
            return { ...shot, fileKey: candidate.fileKey };
        }));
        return enqueue("render", plan.id, key, { revision, variant, audioKey: doc.audioKey, options: doc.options, units: doc.units.map(({ text, startFrame, endFrame }) => ({ text, startFrame, endFrame })), shots, requestId: req.body.requestId }, tx);
    });
    res.status(202).json({ id: job.id, status: job.status });
});
semanticRouter.post("/plans/:id/jobs/:jobId/retry", async (req, res) => {
    await owned(req.params.id, req.user!.id);
    const updated = await prisma.autoVideoJob.updateMany({ where: { id: id.parse(req.params.jobId), targetId: String(req.params.id), kind: "render", status: "failed" }, data: { status: "queued", attempts: 0, availableAt: new Date(), error: null } });
    res.json({ ok: !!updated.count });
});
semanticRouter.get("/plans/:id/audio", async (req, res) => {
    const plan = await owned(req.params.id, req.user!.id);
    const doc = plan.document as PlanDocument | null;
    if (!doc) throw fail("配音尚未生成", 404);
    await forwardStream(req, res, `/api/v1/semantic/artifacts/${id.parse(doc.audioKey)}/audio.wav`);
});
semanticRouter.get("/plans/:id/jobs/:jobId/video", async (req, res) => {
    await owned(req.params.id, req.user!.id);
    const job = await prisma.autoVideoJob.findFirst({ where: { id: id.parse(req.params.jobId), targetId: String(req.params.id), kind: "render", status: "succeeded" } });
    if (!job) throw fail("产物尚未生成", 404);
    await forwardStream(req, res, `/api/v1/semantic/artifacts/${job.id}/output.mp4`);
});

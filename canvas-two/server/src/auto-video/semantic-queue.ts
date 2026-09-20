import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";

export const json = (value: unknown) => value as Prisma.InputJsonValue;
export async function enqueue(kind: string, targetId: string, dedupeKey: string, payload: unknown, db: any = prisma) {
    return db.autoVideoJob.upsert({ where: { dedupeKey }, create: { kind, targetId, dedupeKey, payload: json(payload) }, update: {} });
}
let stopping = false;
export function stopSemanticWorkers() { stopping = true; }
export async function fenced(job: any, action: (tx: any) => Promise<void>) {
    await prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<any[]>`SELECT id FROM auto_video_jobs WHERE id=${job.id} AND lease_token=${job.leaseToken} AND status='running' AND lease_until>NOW() FOR UPDATE`;
        if (!rows.length) throw Object.assign(new Error("任务租约失效"), { status: 409 });
        await action(tx);
    });
}
async function loop(kinds: string[], lane: number) {
    while (!stopping) {
        let job: any;
        try {
            job = await prisma.$transaction(async (tx) => {
                // PostgreSQL advisory lock gives each lane a global concurrency limit across worker processes.
                await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(91371, ${lane})`;
                const active = await tx.autoVideoJob.findFirst({ where: { leaseToken: { startsWith: `${lane}:` }, status: "running", leaseUntil: { gt: new Date() } } });
                if (active) return null;
                const rows = await tx.$queryRaw<any[]>(Prisma.sql`SELECT id FROM auto_video_jobs WHERE kind IN (${Prisma.join(kinds)}) AND ((status='queued' AND available_at<=NOW()) OR (status='running' AND lease_until<NOW())) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`);
                if (!rows.length) return null;
                return tx.autoVideoJob.update({ where: { id: rows[0].id }, data: { status: "running", leaseToken: `${lane}:${randomUUID()}`, leaseUntil: new Date(Date.now() + 90000), attempts: { increment: 1 } } });
            });
            if (job) {
                const heartbeat = setInterval(() => void prisma.autoVideoJob.updateMany({ where: { id: job.id, leaseToken: job.leaseToken, status: "running" }, data: { leaseUntil: new Date(Date.now() + 90000) } }).catch(() => undefined), 15000);
                try {
                    const { processSemanticJob } = await import("./semantic-process.js");
                    await processSemanticJob(job);
                    await fenced(job, async (tx) => { await tx.autoVideoJob.update({ where: { id: job.id }, data: { status: "succeeded", error: null, leaseUntil: null } }); });
                } catch (error) {
                    const retry = (error as any)?.status >= 500 && job.attempts < 3;
                    const message = error instanceof Error ? error.message.slice(0, 600) : "后台处理失败";
                    await fenced(job, async (tx) => {
                        await tx.autoVideoJob.update({ where: { id: job.id }, data: { status: retry ? "queued" : "failed", error: `${job.kind}: ${message}`, availableAt: new Date(Date.now() + 10000 * job.attempts), leaseUntil: null } });
                        if (job.kind === "plan") await tx.autoVideoPlan.updateMany({ where: { id: job.targetId, revision: job.payload.revision }, data: { status: retry ? "queued" : "failed", error: message } });
                        if (job.kind === "analyze" || job.kind === "index") await tx.localVideoMaterial.updateMany({ where: { id: job.targetId, revision: job.payload.revision }, data: { analysisStatus: retry ? "queued" : "failed", analysisError: message } });
                    }).catch(() => undefined);
                } finally { clearInterval(heartbeat); }
            }
        } catch (error) { console.error("[semantic-worker]", error instanceof Error ? error.message : "队列失败"); }
        if (!job) await new Promise((resolve) => setTimeout(resolve, 2000));
    }
}
export async function startSemanticWorkers() {
    stopping = false;
    await Promise.all([loop(["analyze", "index"], 0), loop(["analyze", "index"], 1), loop(["plan"], 2), loop(["render"], 3)]);
}

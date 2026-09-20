import { apiUrl } from "@/lib/app-path";
import { serverApi, jsonBody } from "@/services/server-api";
import type { MaterialAnnotation } from "@/services/local-materials";

export type Candidate = { id: string; fileName: string; duration: number; width: number; height: number; revision: number; annotation: MaterialAnnotation; grade: "strong" | "uncertain" | "none"; reason: string; missing: string[] };
export type Shot = { materialId: string; sourceStart: number; sourceEnd: number; speed: number; frames: number; manual: boolean };
export type UnitEdit = { shots: Shot[]; confirmed: boolean; allowRepeat: boolean };
export type Unit = { start: number; end: number; text: string; query: string; evidence: string[]; tags: string[]; generic: boolean; startFrame: number; endFrame: number; candidates: Candidate[] };
export type Plan = { id: string; status: string; revision: number; input: Record<string, any>; error?: string; createdAt: string; document?: { audioKey: string; duration: number; fps: number; units: Unit[]; variants: UnitEdit[][]; options: Record<string, any> }; jobs?: { id: string; kind: string; status: string; error?: string; dedupeKey: string; result?: { warnings?: string[] } }[] };
export type PlanSummary = { id: string; status: string; revision: number; input: Record<string, any>; error?: string; createdAt: string };
export function semanticApi<T = any>(path: string, body?: unknown, method = "POST") {
    // 未携带请求体时按读取语义默认走 GET，避免对写接口发起空体 POST 触发参数校验报错。
    const resolved = body === undefined ? "GET" : method;
    return serverApi<T>(`/api/auto-video${path}`, body === undefined ? { method: resolved } : { method: resolved, ...jsonBody(body) });
}
export const planAudio = (id: string) => apiUrl(`/api/auto-video/plans/${id}/audio`);
export const planVideo = (id: string, job: string) => apiUrl(`/api/auto-video/plans/${id}/jobs/${job}/video`);

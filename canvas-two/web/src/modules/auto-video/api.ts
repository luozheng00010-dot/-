import { apiUrl } from "@/lib/app-path";
import { ApiError, jsonBody, serverApi } from "@/services/server-api";

export interface AutoVideoModelSettings { channelId: string | null; model: string | null; visionChannelId?: string | null; visionModel?: string | null; embedChannelId?: string | null; embedModel?: string | null; visionVerified?: string | null; storageDir?: string | null; storageDefaultDir?: string | null; jianyingDir?: string | null }
export interface AutoVideoModelChannel { id: string; name: string; apiFormat: string; models: string[] }
export const getAutoVideoSettings = () => serverApi<{ settings: AutoVideoModelSettings; channels: AutoVideoModelChannel[] }>("/api/auto-video/admin/settings");
export const saveAutoVideoSettings = (input: AutoVideoModelSettings) => serverApi<{ settings: AutoVideoModelSettings }>("/api/auto-video/admin/settings", { method: "PUT", ...jsonBody(input) });

/**
 * 自动剪辑模块 API 客户端。所有请求走主服务端 /api/auto-video/*，
 * 由服务端代理到语义剪辑引擎 FastAPI（见 server/src/auto-video/routes.ts）。
 * 上游统一返回 { status, message, data } 信封。
 */

export interface MptEnvelope<T> {
    status: number;
    message?: string;
    data: T;
}

export interface AutoVideoVoice {
    name: string;
    gender: string;
}

export interface AutoVideoFileEntry {
    name: string;
    size: number;
    file: string;
}

async function autoVideoApi<T>(path: string, init?: RequestInit): Promise<T> {
    const headers = new Headers(init?.headers);
    if (init?.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    const response = await fetch(apiUrl(`/api/auto-video${path}`), { ...init, headers, credentials: "include" });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
        const message = (body as { error?: string } | null)?.error || `请求失败：${response.status}`;
        throw new ApiError(message, response.status);
    }
    const envelope = body as MptEnvelope<T> | T;
    if (envelope && typeof envelope === "object" && "data" in envelope && "status" in envelope) return (envelope as MptEnvelope<T>).data;
    return envelope as T;
}

export async function checkAutoVideoHealth() {
    return autoVideoApi<{ status: "up" | "down" }>("/health");
}

export async function listVoices() {
    return autoVideoApi<AutoVideoFileEntry[] | AutoVideoVoice[]>("/voices");
}

export async function listFonts() {
    return autoVideoApi<string[]>("/fonts");
}

export async function listMusics() {
    return autoVideoApi<{ files: AutoVideoFileEntry[] }>("/musics");
}

export async function uploadMusic(file: File) {
    const form = new FormData();
    form.append("file", file);
    return autoVideoApi<{ file: string }>("/musics/upload", { method: "POST", body: form });
}

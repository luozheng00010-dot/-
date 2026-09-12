import { apiUrl } from "@/lib/app-path";

export class ApiError extends Error {
    status: number;
    code?: string;
    constructor(message: string, status: number, code?: string) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

export async function serverApi<T>(path: string, init?: RequestInit): Promise<T> {
    const headers = new Headers(init?.headers);
    if (init?.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    const response = await fetch(apiUrl(path), { ...init, headers, credentials: "include" });
    const contentType = response.headers.get("content-type") || "";
    const body = contentType.includes("application/json") ? await response.json() : await response.text();
    if (!response.ok) {
        const value = body as { error?: string; code?: string };
        throw new ApiError(value?.error || `请求失败：${response.status}`, response.status, value?.code);
    }
    return body as T;
}

export function jsonBody(value: unknown): RequestInit {
    return { body: JSON.stringify(value) };
}

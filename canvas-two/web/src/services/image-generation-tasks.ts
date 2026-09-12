import { nanoid } from "nanoid";
import { ApiError, serverApi } from "@/services/server-api";
import { selectedOwnerId } from "@/stores/use-owner-scope-store";

export type ImageGenerationTaskStatus = "queued" | "running" | "succeeded" | "partial" | "failed" | "cancelled";
export type ImageGenerationTaskImage = { id: string; dataUrl: string; url: string; thumbnailUrl: string; storageKey: string; width: number; height: number; bytes: number; mimeType: string };
export type ImageGenerationTaskResult = { index: number; status: "queued" | "running" | "succeeded" | "failed"; image?: ImageGenerationTaskImage; error?: string };
export type ImageGenerationTaskBinding = { nodeId: string; slot?: number };
export type ImageGenerationTaskContext = Record<string, unknown> & {
    canvasId?: string;
    bindings?: ImageGenerationTaskBinding[];
    origin?: string;
    productId?: string;
    detailPageProjectId?: string;
    pairId?: string;
};
export type ImageGenerationTask = {
    id: string;
    ownerId: string;
    clientRequestId: string;
    retryOfId?: string;
    operation: "generation" | "edit";
    model: string;
    prompt: string;
    parameters: Record<string, unknown>;
    references: Array<{ mediaId: string; name: string; type: string }>;
    context?: ImageGenerationTaskContext;
    status: ImageGenerationTaskStatus;
    completedCount: number;
    totalCount: number;
    results: ImageGenerationTaskResult[];
    error?: string;
    createdAt: string;
    updatedAt: string;
    startedAt?: string;
    completedAt?: string;
};

export type SubmitImageGenerationTaskInput = {
    ownerId?: string;
    clientRequestId?: string;
    channelId: string;
    operation: "generation" | "edit";
    model: string;
    prompt: string;
    requestPrompt: string;
    count: number;
    parameters: Record<string, unknown>;
    references?: Array<{ mediaId: string; name: string; type: string }>;
    maskMediaId?: string;
    context?: ImageGenerationTaskContext;
};

const terminal = new Set<ImageGenerationTaskStatus>(["succeeded", "partial", "failed", "cancelled"]);
const wait = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { window.clearTimeout(timer); reject(new DOMException("请求已取消", "AbortError")); }, { once: true });
});

export async function submitImageGenerationTask(input: SubmitImageGenerationTaskInput) {
    const { task } = await serverApi<{ task: ImageGenerationTask }>("/api/image-generation-tasks", { method: "POST", body: JSON.stringify({ ...input, clientRequestId: input.clientRequestId || nanoid(), ownerId: input.ownerId || selectedOwnerId() }) });
    return task;
}

export async function getImageGenerationTask(id: string) {
    const { task } = await serverApi<{ task: ImageGenerationTask }>(`/api/image-generation-tasks/${id}`);
    return task;
}

export async function listImageGenerationTasks(status = "active", options?: { canvasId?: string; clientRequestId?: string; owner?: string }) {
    const params = new URLSearchParams({ owner: options?.owner || selectedOwnerId(), status });
    if (options?.canvasId) params.set("canvasId", options.canvasId);
    if (options?.clientRequestId) params.set("clientRequestId", options.clientRequestId);
    const { tasks } = await serverApi<{ tasks: ImageGenerationTask[] }>(`/api/image-generation-tasks?${params.toString()}`);
    return tasks;
}

export async function findImageGenerationTask(identifier: string) {
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(identifier)) {
        try { return await getImageGenerationTask(identifier); }
        catch (error) { if (!(error instanceof ApiError) || error.status !== 404) throw error; }
    }
    const { tasks } = await serverApi<{ tasks: ImageGenerationTask[] }>(`/api/image-generation-tasks?owner=all&clientRequestId=${encodeURIComponent(identifier)}`);
    return tasks[0];
}

export async function waitForImageGenerationTask(id: string, options?: { signal?: AbortSignal; onUpdate?: (task: ImageGenerationTask) => void }) {
    let delay = 2_000;
    while (true) {
        try {
            const task = await getImageGenerationTask(id);
            options?.onUpdate?.(task);
            if (terminal.has(task.status)) return task;
            delay = 2_000;
        } catch (error) {
            if (options?.signal?.aborted) throw new DOMException("请求已取消", "AbortError");
            delay = Math.min(10_000, delay * 2);
            if (!(error instanceof TypeError) && (!(error instanceof ApiError) || error.status < 500)) throw error;
        }
        await wait(delay, options?.signal);
    }
}

export async function cancelImageGenerationTask(id: string) {
    const { task } = await serverApi<{ task: ImageGenerationTask }>(`/api/image-generation-tasks/${id}/cancel`, { method: "POST", body: "{}" });
    return task;
}

export async function retryImageGenerationTask(id: string, clientRequestId = nanoid()) {
    const { task } = await serverApi<{ task: ImageGenerationTask }>(`/api/image-generation-tasks/${id}/retry`, { method: "POST", body: JSON.stringify({ clientRequestId }) });
    return task;
}

export function isImageGenerationTaskTerminal(status: ImageGenerationTaskStatus) { return terminal.has(status); }

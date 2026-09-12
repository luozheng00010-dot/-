import { apiUrl } from "@/lib/app-path";
import { serverApi } from "@/services/server-api";

export type CanvasEditLease = {
    holderId: string;
    holderUsername: string;
    clientId: string;
    acquiredAt: string;
    heartbeatAt: string;
    expiresAt: string;
};

export type CanvasRevisionState = {
    revision: number;
    updatedAt: string;
    accessLevel: "view" | "edit";
    lease?: CanvasEditLease;
};

const CLIENT_ID_KEY = "canvas-edit-client-id";

export function getCanvasClientId() {
    if (typeof window === "undefined") return "server-client";
    const existing = window.sessionStorage.getItem(CLIENT_ID_KEY);
    if (existing) return existing;
    const value = `${crypto.randomUUID()}-${Math.random().toString(36).slice(2, 8)}`;
    window.sessionStorage.setItem(CLIENT_ID_KEY, value);
    return value;
}

export async function acquireCanvasEditLease(id: string, takeover = false) {
    return serverApi<{ acquired: boolean; lease?: CanvasEditLease }>(`/api/canvases/${id}/edit-lease`, {
        method: "POST",
        body: JSON.stringify({ clientId: getCanvasClientId(), takeover }),
    });
}

export async function heartbeatCanvasEditLease(id: string) {
    return serverApi<{ acquired: boolean; lease?: CanvasEditLease }>(`/api/canvases/${id}/edit-lease/heartbeat`, {
        method: "POST",
        body: JSON.stringify({ clientId: getCanvasClientId() }),
    });
}

export async function releaseCanvasEditLease(id: string, keepalive = false) {
    if (!keepalive) {
        await serverApi(`/api/canvases/${id}/edit-lease/release`, {
            method: "POST",
            body: JSON.stringify({ clientId: getCanvasClientId() }),
        });
        return;
    }
    void fetch(apiUrl(`/api/canvases/${id}/edit-lease/release`), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId: getCanvasClientId() }),
        keepalive: true,
    }).catch(() => undefined);
}

export async function getCanvasRevision(id: string) {
    return serverApi<CanvasRevisionState>(`/api/canvases/${id}/revision`);
}

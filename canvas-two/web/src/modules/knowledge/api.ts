import { apiUrl } from "@/lib/app-path";
import { ApiError, jsonBody, serverApi } from "@/services/server-api";
import type {
    KbCategory,
    KbChannelOption,
    KbCitation,
    KbComment,
    KbConversation,
    KbMessage,
    KbPostCard,
    KbPostDetail,
    KbPostType,
    KbSettings,
    KbStats,
} from "./types";

/** 公司知识库 API 客户端；模块内自包含，不依赖其他业务模块。 */

export interface KbPostListQuery {
    scope?: "all" | "mine";
    category?: string;
    tag?: string;
    keyword?: string;
    type?: KbPostType;
    sort?: "latest" | "hottest";
    page?: number;
    pageSize?: number;
}

export async function listKbPosts(query: KbPostListQuery = {}) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== "") params.set(key, String(value));
    }
    const suffix = params.size ? `?${params.toString()}` : "";
    return serverApi<{ total: number; items: KbPostCard[] }>(`/api/kb/posts${suffix}`);
}

export interface KbPostInput {
    title: string;
    type: KbPostType;
    categoryId?: string | null;
    tags: string[];
    content: string;
    status: "draft" | "published";
}

export async function createKbPost(input: KbPostInput) {
    return serverApi<{ post: KbPostCard }>("/api/kb/posts", { method: "POST", ...jsonBody(input) });
}

export async function updateKbPost(id: string, input: Partial<KbPostInput>) {
    return serverApi<{ post: KbPostCard }>(`/api/kb/posts/${id}`, { method: "PATCH", ...jsonBody(input) });
}

export async function getKbPost(id: string) {
    return serverApi<{ post: KbPostDetail; comments: KbComment[]; related: KbPostCard[] }>(`/api/kb/posts/${id}`);
}

export async function archiveKbPost(id: string) {
    return serverApi<{ ok: true }>(`/api/kb/posts/${id}`, { method: "DELETE" });
}

export async function addKbComment(postId: string, input: { content: string; parentId?: string }) {
    return serverApi<{ comment: KbComment }>(`/api/kb/posts/${postId}/comments`, { method: "POST", ...jsonBody(input) });
}

export async function listKbCategories() {
    return serverApi<{ categories: KbCategory[] }>("/api/kb/categories");
}

export async function createKbCategory(input: { name: string; sort?: number }) {
    return serverApi<{ category: KbCategory }>("/api/kb/admin/categories", { method: "POST", ...jsonBody(input) });
}

export async function updateKbCategory(id: string, input: Partial<{ name: string; sort: number }>) {
    return serverApi<{ category: KbCategory }>(`/api/kb/admin/categories/${id}`, { method: "PATCH", ...jsonBody(input) });
}

export async function deleteKbCategory(id: string) {
    return serverApi<{ ok: true }>(`/api/kb/admin/categories/${id}`, { method: "DELETE" });
}

export async function pinKbPost(id: string, official: boolean) {
    return serverApi<{ post: KbPostCard }>(`/api/kb/admin/posts/${id}/pin-official`, { method: "POST", ...jsonBody({ official }) });
}

// ===== AI 对话 =====

export async function listKbConversations() {
    return serverApi<{ conversations: KbConversation[] }>("/api/kb/chat/conversations");
}

export async function createKbConversation(title = "新会话") {
    return serverApi<{ conversation: KbConversation }>("/api/kb/chat/conversations", { method: "POST", ...jsonBody({ title }) });
}

export async function getKbConversation(id: string) {
    return serverApi<{ conversation: KbConversation; messages: KbMessage[] }>(`/api/kb/chat/conversations/${id}`);
}

export async function renameKbConversation(id: string, title: string) {
    return serverApi<{ conversation: KbConversation }>(`/api/kb/chat/conversations/${id}`, { method: "PATCH", ...jsonBody({ title }) });
}

export async function deleteKbConversation(id: string) {
    return serverApi<{ ok: true }>(`/api/kb/chat/conversations/${id}`, { method: "DELETE" });
}

export async function sendKbFeedback(messageId: string, feedback: 1 | -1) {
    return serverApi<{ message: KbMessage }>(`/api/kb/chat/messages/${messageId}/feedback`, { method: "POST", ...jsonBody({ feedback }) });
}

export interface KbChatStreamHandlers {
    onDelta: (delta: string) => void;
    onDone: (message: KbMessage, citations: KbCitation[]) => void;
    onError: (error: string) => void;
}

/** 提问并流式读取 SSE（delta / done / error 三类事件） */
export async function streamKbMessage(conversationId: string, content: string, handlers: KbChatStreamHandlers, signal?: AbortSignal) {
    const response = await fetch(apiUrl(`/kb/chat/conversations/${conversationId}/messages`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ content }),
        signal,
    });
    if (!response.ok || !response.body) {
        let message = `请求失败：${response.status}`;
        try {
            const payload = await response.json();
            if (payload?.error) message = payload.error;
        } catch { /* 保留默认错误 */ }
        throw new ApiError(message, response.status);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() || "";
        for (const block of blocks) {
            const event = block.match(/^event: (\S+)/m)?.[1];
            const dataLine = block.split("\n").find((line) => line.startsWith("data: "));
            if (!event || !dataLine) continue;
            let payload: any;
            try { payload = JSON.parse(dataLine.slice(6)); } catch { continue; }
            if (event === "delta") handlers.onDelta(String(payload.delta || ""));
            else if (event === "done") handlers.onDone(payload.message as KbMessage, (payload.citations as KbCitation[]) || []);
            else if (event === "error") handlers.onError(String(payload.error || "回答生成失败"));
        }
    }
}

// ===== 管理端 =====

export async function getKbAdminSettings() {
    return serverApi<{ settings: KbSettings; channels: KbChannelOption[] }>("/api/kb/admin/settings");
}

export async function updateKbAdminSettings(input: Partial<KbSettings>) {
    return serverApi<{ settings: KbSettings }>("/api/kb/admin/settings", { method: "PUT", ...jsonBody(input) });
}

export async function getKbAdminStats() {
    return serverApi<KbStats>("/api/kb/admin/stats");
}

import { create } from "zustand";

import type { AgentAttachment, AgentChatItem, AgentEventLog, AgentPanelTab, AgentPendingToolCall } from "@/stores/use-agent-store";
import type { ApiAgentMessage, ApiAgentSession } from "@/types/api-agent";

export type ApiAgentStore = {
    activeTab: AgentPanelTab;
    prompt: string;
    attachments: AgentAttachment[];
    messages: AgentChatItem[];
    protocolMessages: ApiAgentMessage[];
    eventLogs: AgentEventLog[];
    sessions: ApiAgentSession[];
    activeSessionId: string;
    model: string;
    sending: boolean;
    waiting: boolean;
    loadingSessions: boolean;
    confirmTools: boolean;
    pendingTool: AgentPendingToolCall | null;
    error: string;
    setState: (patch: Partial<Omit<ApiAgentStore, "setState" | "addMessage" | "addEventLog">>) => void;
    addMessage: (message: AgentChatItem) => void;
    addEventLog: (log: AgentEventLog) => void;
};

export const useApiAgentStore = create<ApiAgentStore>((set) => ({
    activeTab: "chat",
    prompt: "",
    attachments: [],
    messages: [],
    protocolMessages: [],
    eventLogs: [],
    sessions: [],
    activeSessionId: "",
    model: typeof window === "undefined" ? "" : localStorage.getItem("canvas-api-agent-model") || "",
    sending: false,
    waiting: false,
    loadingSessions: false,
    confirmTools: false,
    pendingTool: null,
    error: "",
    setState: (patch) => set(patch),
    addMessage: (message) => set((state) => ({ messages: [...state.messages.slice(-160), message] })),
    addEventLog: (log) => set((state) => ({ eventLogs: [...state.eventLogs.slice(-160), log] })),
}));

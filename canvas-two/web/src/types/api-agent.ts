import type { AgentAttachment } from "@/stores/use-agent-store";

export type ApiAgentToolCall = { id: string; name: string; arguments: string };

export type ApiAgentMessage = {
    id: string;
    role: "user" | "assistant" | "tool";
    content: string;
    createdAt: number;
    attachments?: AgentAttachment[];
    toolCalls?: ApiAgentToolCall[];
    toolCallId?: string;
    name?: string;
};

export type ApiAgentSession = {
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    messages: ApiAgentMessage[];
};

export type ApiAgentStreamToolCall = ApiAgentToolCall & { index: number };
export type ApiAgentStreamEvent =
    | { type: "assistant_start"; message: ApiAgentMessage }
    | { type: "assistant_delta"; messageId: string; delta: string }
    | { type: "assistant_done"; message: ApiAgentMessage }
    | { type: "tool_start"; call: ApiAgentToolCall; input: Record<string, unknown> }
    | { type: "tool_done"; call: ApiAgentToolCall; result: unknown; error?: string };

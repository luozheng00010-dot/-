import { buildApiUrl, resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";
import type { ApiAgentMessage, ApiAgentToolCall } from "@/types/api-agent";
import type { ApiAgentToolDefinition } from "@/lib/agent/api-agent-tools";

const MAX_TOOL_ROUNDS = 12;
const MAX_TOOL_RESULT_CHARS = 20_000;

export const API_AGENT_SYSTEM_PROMPT = `你是 Infinite Canvas 的画布创作 Agent。优先理解并操作当前画布，不要假装执行工具。

规则：
- 需要了解画布时先调用 canvas_get_state 或 canvas_get_selection。
- 创建内容时优先使用高层工具；需要一次修改多个节点时使用 canvas_apply_ops。
- 用户要求生成图片、文本、视频或音频时，优先创建画布生成流程并触发生成，不要声称已生成但不调用工具。
- 使用用户上传图片时，先调用 canvas_create_attachment_nodes，再把返回节点作为 referenceNodeIds。
- 删除、覆盖或大范围修改前先明确对象；工具失败后根据错误调整参数，不要无意义重复。
- 你只能使用提供的网站和画布工具，不能执行终端命令、访问本地文件或声称具备这些能力。
- 最终用简洁中文说明完成了什么。`;

type RunApiAgentOptions = {
    config: AiConfig;
    model: string;
    messages: ApiAgentMessage[];
    tools: ApiAgentToolDefinition[];
    signal: AbortSignal;
    executeTool: (call: ApiAgentToolCall, input: Record<string, unknown>) => Promise<unknown>;
    onAssistantStart: (message: ApiAgentMessage) => void;
    onAssistantDelta: (messageId: string, delta: string) => void;
    onAssistantDone: (message: ApiAgentMessage) => void;
    onToolStart: (call: ApiAgentToolCall, input: Record<string, unknown>) => void;
    onToolDone: (call: ApiAgentToolCall, result: unknown, error?: string) => void;
    onMessage?: (message: ApiAgentMessage) => void;
};

export async function runApiAgent(options: RunApiAgentOptions) {
    const requestConfig = resolveModelRequestConfig(options.config, options.model);
    if (!requestConfig.baseUrl.trim()) throw new Error("请先配置 API Base URL");
    if (!requestConfig.apiKey.trim() && requestConfig.source !== "remote") throw new Error("请先配置 API Key");
    if (requestConfig.apiFormat === "gemini") throw new Error("API Agent 第一版仅支持 OpenAI 兼容渠道");

    const appended: ApiAgentMessage[] = [];
    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
        const response = await requestChatCompletion(requestConfig, [...options.messages, ...appended], options.tools, options.signal, options.onAssistantStart, options.onAssistantDelta);
        const assistant: ApiAgentMessage = { id: response.id, role: "assistant", content: response.content, toolCalls: response.toolCalls, createdAt: Date.now() };
        options.onAssistantDone(assistant);
        if (!response.content && !response.toolCalls.length) throw new Error("模型未返回文本或工具调用，请确认所选模型支持 Chat Completions 流式响应");
        appended.push(assistant);
        options.onMessage?.(assistant);
        if (!response.toolCalls.length) return appended;

        for (const call of response.toolCalls) {
            let input: Record<string, unknown> = {};
            let result: unknown;
            let error = "";
            let started = false;
            try {
                input = parseToolArguments(call.arguments);
                options.onToolStart(call, input);
                started = true;
                result = await options.executeTool(call, input);
            } catch (cause) {
                if (!started) options.onToolStart(call, input);
                error = cause instanceof Error ? cause.message : "工具执行失败";
                result = { ok: false, error };
            }
            options.onToolDone(call, result, error || undefined);
            const toolMessage: ApiAgentMessage = { id: crypto.randomUUID(), role: "tool", name: call.name, toolCallId: call.id, content: serializeToolResult(result), createdAt: Date.now() };
            appended.push(toolMessage);
            options.onMessage?.(toolMessage);
        }
    }
    throw new Error(`工具调用超过 ${MAX_TOOL_ROUNDS} 轮，已停止本次任务`);
}

async function requestChatCompletion(config: AiConfig, messages: ApiAgentMessage[], tools: ApiAgentToolDefinition[], signal: AbortSignal, onStart: RunApiAgentOptions["onAssistantStart"], onDelta: RunApiAgentOptions["onAssistantDelta"]) {
    const id = crypto.randomUUID();
    onStart({ id, role: "assistant", content: "", createdAt: Date.now() });
    let response: Response;
    try {
        response = await fetch(buildApiUrl(config.baseUrl, "/chat/completions"), {
            method: "POST",
            headers: { "Content-Type": "application/json", ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}) },
            body: JSON.stringify({
                model: config.model,
                messages: toRequestMessages(config, messages),
                tools,
                tool_choice: "auto",
                stream: true,
                ...(config.reasoningEffort === "auto" ? {} : { reasoning_effort: config.reasoningEffort }),
            }),
            signal,
        });
    } catch (error) {
        if (signal.aborted) throw new DOMException("请求已停止", "AbortError");
        throw new Error(error instanceof TypeError ? "无法连接模型接口，请检查地址、网络和浏览器 CORS 设置" : error instanceof Error ? error.message : "模型请求失败");
    }
    if (!response.ok) throw new Error(await responseError(response, config.apiKey));

    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
        const body = await response.json() as ChatCompletionResponse;
        if (body.error) throw new Error(safeProviderMessage(providerErrorText(body.error), config.apiKey) || "模型返回错误");
        const message = body.choices?.[0]?.message;
        const content = contentText(message?.content);
        if (content) onDelta(id, content);
        return { id, content, toolCalls: normalizeToolCalls(message?.tool_calls) };
    }
    if (!response.body) throw new Error("模型接口没有返回响应流");

    let content = "";
    const toolCalls = new Map<number, ApiAgentToolCall>();
    await readSse(response.body, (payload) => {
        if (payload === "[DONE]") return;
        let chunk: ChatCompletionChunk;
        try { chunk = JSON.parse(payload) as ChatCompletionChunk; } catch { throw new Error("模型返回了无法解析的流式数据"); }
        if (chunk.error) throw new Error(safeProviderMessage(providerErrorText(chunk.error), config.apiKey) || "模型流返回错误");
        const delta = chunk.choices?.[0]?.delta;
        const text = contentText(delta?.content);
        if (text) {
            content += text;
            onDelta(id, text);
        }
        for (const item of delta?.tool_calls || []) {
            const index = Number(item.index) || 0;
            const current = toolCalls.get(index) || { id: item.id || `tool-${id}-${index}`, name: "", arguments: "" };
            const nameDelta = item.function?.name || "";
            const name = !nameDelta || current.name === nameDelta ? current.name : nameDelta.startsWith(current.name) ? nameDelta : current.name.endsWith(nameDelta) ? current.name : `${current.name}${nameDelta}`;
            toolCalls.set(index, { id: item.id || current.id, name, arguments: `${current.arguments}${item.function?.arguments || ""}` });
        }
    });
    return { id, content, toolCalls: [...toolCalls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call) };
}

function toRequestMessages(config: AiConfig, messages: ApiAgentMessage[]) {
    const system = [API_AGENT_SYSTEM_PROMPT, config.systemPrompt.trim()].filter(Boolean).join("\n\n补充要求：\n");
    return [{ role: "system", content: system }, ...recentTurns(messages, 20).map((message) => {
        if (message.role === "tool") return { role: "tool", tool_call_id: message.toolCallId, name: message.name, content: message.content };
        if (message.role === "assistant") return { role: "assistant", content: message.content || null, ...(message.toolCalls?.length ? { tool_calls: message.toolCalls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } })) } : {}) };
        const content = message.attachments?.length
            ? [{ type: "text", text: attachmentPrompt(message) }, ...message.attachments.map((attachment) => ({ type: "image_url", image_url: { url: attachment.dataUrl } }))]
            : message.content;
        return { role: "user", content };
    })];
}

function attachmentPrompt(message: ApiAgentMessage) {
    const list = (message.attachments || []).map((attachment, index) => `${index + 1}. ${attachment.name}（attachmentId: ${attachment.id}）`).join("\n");
    return `${message.content || "请结合这些图片完成任务。"}\n\n本轮可用图片附件：\n${list}\n需要把图片放入画布或作为生成参考图时，先调用 canvas_create_attachment_nodes。`;
}

function recentTurns(messages: ApiAgentMessage[], limit: number) {
    const starts = messages.flatMap((message, index) => message.role === "user" ? [index] : []);
    const start = starts.length > limit ? starts[starts.length - limit] : 0;
    return messages.slice(start);
}

async function readSse(stream: ReadableStream<Uint8Array>, onData: (data: string) => void) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let eventData: string[] = [];
    const flushLine = (line: string) => {
        if (!line) {
            if (eventData.length) onData(eventData.join("\n"));
            eventData = [];
        } else if (line.startsWith("data:")) eventData.push(line.slice(5).trimStart());
    };
    while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";
        lines.forEach(flushLine);
        if (done) break;
    }
    if (buffer) flushLine(buffer);
    flushLine("");
}

function parseToolArguments(value: string) {
    if (!value.trim()) return {};
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("工具参数必须是对象");
    return parsed as Record<string, unknown>;
}

function serializeToolResult(value: unknown) {
    let text: string;
    try { text = JSON.stringify(value ?? null); } catch { text = JSON.stringify({ ok: false, error: "工具结果无法序列化" }); }
    return text.length > MAX_TOOL_RESULT_CHARS ? JSON.stringify({ ok: true, truncated: true, note: "工具结果过长，已截断", preview: text.slice(0, MAX_TOOL_RESULT_CHARS - 200) }) : text;
}

async function responseError(response: Response, apiKey: string) {
    const body = await response.json().catch(() => null) as { error?: { message?: string } | string; message?: string } | null;
    const detail = safeProviderMessage(typeof body?.error === "string" ? body.error : body?.error?.message || body?.message, apiKey);
    if (response.status === 401) return "API Key 无效或无权访问所选模型";
    if (response.status === 403) return "所选模型无权访问，或未在管理员渠道中启用";
    if (response.status === 404) return "模型接口或模型不存在，请检查 Base URL 和模型名";
    if (response.status === 400 && /tool|function/i.test(detail)) return "所选模型或渠道不支持 OpenAI Chat Completions 工具调用";
    return detail || `模型请求失败：${response.status}`;
}

function providerErrorText(value: unknown) {
    if (typeof value === "string") return value;
    if (!value || typeof value !== "object") return "";
    const error = value as { message?: unknown; error?: { message?: unknown } };
    return typeof error.message === "string" ? error.message : typeof error.error?.message === "string" ? error.error.message : "";
}

function safeProviderMessage(value: unknown, apiKey: string) {
    const message = typeof value === "string" ? value.slice(0, 500) : "";
    return apiKey ? message.split(apiKey).join("[API Key 已隐藏]") : message;
}

function normalizeToolCalls(value: unknown): ApiAgentToolCall[] {
    return Array.isArray(value) ? value.flatMap((item) => {
        const call = item as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
        const name = typeof call.function?.name === "string" ? call.function.name : "";
        return name ? [{ id: typeof call.id === "string" ? call.id : crypto.randomUUID(), name, arguments: typeof call.function?.arguments === "string" ? call.function.arguments : "{}" }] : [];
    }) : [];
}

function contentText(value: unknown) {
    if (typeof value === "string") return value;
    if (!Array.isArray(value)) return "";
    return value.map((item) => typeof item === "string" ? item : item && typeof item === "object" && "text" in item ? String((item as { text?: unknown }).text || "") : "").join("");
}

type ChatCompletionChunk = { error?: unknown; choices?: Array<{ delta?: { content?: unknown; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> } }> };
type ChatCompletionResponse = { error?: unknown; choices?: Array<{ message?: { content?: unknown; tool_calls?: unknown } }> };

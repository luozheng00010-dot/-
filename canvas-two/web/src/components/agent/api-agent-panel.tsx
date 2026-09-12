import { useCallback, useEffect, useMemo } from "react";
import { App, Button, Tooltip } from "antd";
import { Bot, History, KeyRound, MessageSquare, PanelRightClose, Plus, Settings2, Terminal } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useShallow } from "zustand/react/shallow";

import { ModelPicker } from "@/components/model-picker";
import { API_AGENT_TOOLS, executeApiAgentTool, isApiAgentCanvasWriteTool, isApiAgentWriteTool } from "@/lib/agent/api-agent-tools";
import { canvasThemes } from "@/lib/canvas-theme";
import { upscaleDataUrl } from "@/lib/canvas/canvas-image-data";
import { readImageMeta } from "@/lib/image-utils";
import { randomId } from "@/lib/utils";
import { deleteApiAgentSessions, listApiAgentSessions, readApiAgentSession, saveApiAgentSession } from "@/services/api-agent-storage";
import { runApiAgent } from "@/services/api/api-agent";
import { modelOptionLabel, modelOptionsFromChannels, resolveModelChannel, selectableModelsByCapability, useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { useApiAgentStore } from "@/stores/use-api-agent-store";
import { useAgentStore, type AgentAttachment, type AgentChatItem, type AgentPendingToolCall, type AgentThreadSummary } from "@/stores/use-agent-store";
import { useThemeStore } from "@/stores/use-theme-store";
import type { ApiAgentMessage, ApiAgentToolCall } from "@/types/api-agent";
import { AgentChatTimeline } from "./agent-chat";
import { AgentChatComposer } from "./agent-chat-composer";
import { toolCallDetail, toolName } from "./agent-event-formatters";
import { AgentHistoryView } from "./agent-history-view";
import { AgentLogView } from "./agent-log-view";
import { AgentPanelTabs } from "./agent-panel-tabs";

let activeApiAgentController: AbortController | null = null;
let pendingApiToolAction: { tool: AgentPendingToolCall; run: () => Promise<unknown>; resolve: (value: unknown) => void; reject: (error: Error) => void } | null = null;

export function ApiAgentPanel() {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { message, modal } = App.useApp();
    const navigate = useNavigate();
    const closePanel = useAgentStore((state) => state.closePanel);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const config = useEffectiveConfig();
    const apiConfig = useMemo(() => {
        const channels = config.channels.map((channel) => channel.apiFormat === "gemini" ? { ...channel, models: channel.models.filter((item) => item.capability !== "text") } : channel);
        return { ...config, channels, models: modelOptionsFromChannels(channels) };
    }, [config]);
    const { activeTab, prompt, attachments, messages, eventLogs, sessions, activeSessionId, model, sending, waiting, loadingSessions, confirmTools, pendingTool, error } = useApiAgentStore(
        useShallow((state) => ({ activeTab: state.activeTab, prompt: state.prompt, attachments: state.attachments, messages: state.messages, eventLogs: state.eventLogs, sessions: state.sessions, activeSessionId: state.activeSessionId, model: state.model, sending: state.sending, waiting: state.waiting, loadingSessions: state.loadingSessions, confirmTools: state.confirmTools, pendingTool: state.pendingTool, error: state.error })),
    );
    const setState = useApiAgentStore((state) => state.setState);
    const addMessage = useApiAgentStore((state) => state.addMessage);
    const addEventLog = useApiAgentStore((state) => state.addEventLog);
    const textModels = selectableModelsByCapability(apiConfig, "text");
    const readyModels = textModels.filter((value) => isAgentModelReady(apiConfig, value));
    const selectedModel = readyModels.includes(model) ? model : readyModels.includes(config.textModel) ? config.textModel : readyModels[0] || "";
    const busy = sending || waiting;

    const refreshSessions = useCallback(async () => {
        setState({ loadingSessions: true });
        try { setState({ sessions: await listApiAgentSessions(), loadingSessions: false }); }
        catch { setState({ loadingSessions: false }); }
    }, [setState]);

    useEffect(() => { void refreshSessions(); }, [refreshSessions]);
    useEffect(() => {
        if (!activeSessionId || useApiAgentStore.getState().protocolMessages.length) return;
        void readApiAgentSession(activeSessionId).then((session) => {
            if (!session || useApiAgentStore.getState().activeSessionId !== activeSessionId) return;
            setState({ protocolMessages: session.messages, ...(!useApiAgentStore.getState().messages.length ? { messages: displayMessages(session.messages) } : {}) });
        });
    }, [activeSessionId, setState]);
    useEffect(() => {
        if (!selectedModel) {
            if (activeTab === "chat" && !busy) setState({ activeTab: "setup" });
            return;
        }
        if (selectedModel === model) return;
        localStorage.setItem("canvas-api-agent-model", selectedModel);
        setState({ model: selectedModel });
    }, [activeTab, busy, model, selectedModel, setState]);

    const persist = useCallback(async (sessionId: string, title: string, createdAt: number) => {
        const session = await saveApiAgentSession({ id: sessionId, title, createdAt, updatedAt: Date.now(), messages: useApiAgentStore.getState().protocolMessages });
        setState({ sessions: [session, ...useApiAgentStore.getState().sessions.filter((item) => item.id !== session.id)] });
    }, [setState]);

    const startNewSession = () => {
        if (busy) return;
        setState({ activeSessionId: "", messages: [], protocolMessages: [], prompt: "", attachments: [], pendingTool: null, error: "", activeTab: "chat" });
    };

    const resumeSession = async (id: string) => {
        if (busy) return;
        const session = await readApiAgentSession(id);
        if (!session) return message.error("对话记录不存在");
        setState({ activeSessionId: id, messages: displayMessages(session.messages), protocolMessages: session.messages, attachments: [], prompt: "", pendingTool: null, error: "", activeTab: "chat" });
    };

    const deleteSessions = (ids: string[]) => {
        modal.confirm({
            title: `删除 ${ids.length} 条对话？`,
            content: "删除后无法恢复。",
            okText: "删除",
            okButtonProps: { danger: true },
            cancelText: "取消",
            onOk: async () => {
                await deleteApiAgentSessions(ids);
                if (ids.includes(useApiAgentStore.getState().activeSessionId)) startNewSession();
                await refreshSessions();
            },
        });
    };

    const sendPrompt = async () => {
        const text = prompt.trim();
        if ((!text && !attachments.length) || busy) return;
        if (!selectedModel) {
            setState({ activeTab: "setup" });
            return message.warning("请先配置可用的文本模型");
        }
        const channel = resolveModelChannel(config, selectedModel);
        if (!channel.baseUrl.trim() || (!channel.apiKey.trim() && channel.source !== "remote")) {
            setState({ activeTab: "setup" });
            return message.warning("请先完成个人 API 渠道配置");
        }
        const currentSession = sessions.find((item) => item.id === activeSessionId);
        const sessionId = activeSessionId || crypto.randomUUID();
        const createdAt = currentSession?.createdAt || Date.now();
        const title = currentSession?.title || sessionTitle(text || "图片对话");
        const currentAttachments = attachments;
        let storedAttachments: AgentAttachment[];
        try { storedAttachments = await Promise.all(currentAttachments.map(historyAttachment)); }
        catch { return message.error("图片附件压缩失败，请移除后重试"); }
        const userMessage: ApiAgentMessage = { id: crypto.randomUUID(), role: "user", content: text, attachments: currentAttachments, createdAt: Date.now() };
        const storedUserMessage = { ...userMessage, attachments: storedAttachments };
        const runStatusId = `api-run-${crypto.randomUUID()}`;
        setState({ protocolMessages: [...useApiAgentStore.getState().protocolMessages, storedUserMessage] });
        addMessage({ id: userMessage.id, role: "user", text: text || `发送了 ${currentAttachments.length} 张图片`, historyText: text, attachments: currentAttachments });
        addMessage({ id: runStatusId, role: "system", text: "Agent 正在处理…" });
        setState({ activeSessionId: sessionId, prompt: "", attachments: [], sending: true, waiting: true, error: "", activeTab: "chat" });
        try { await persist(sessionId, title, createdAt); }
        catch {
            setState({ protocolMessages: useApiAgentStore.getState().protocolMessages.filter((item) => item.id !== userMessage.id), messages: useApiAgentStore.getState().messages.filter((item) => item.id !== userMessage.id && item.id !== runStatusId), prompt: text, attachments: currentAttachments, sending: false, waiting: false, error: "对话记录保存失败，请检查浏览器存储空间" });
            return message.error("对话记录保存失败，请检查浏览器存储空间");
        }
        const controller = new AbortController();
        const requestMessages = useApiAgentStore.getState().protocolMessages;
        const toolAttachments = mergeAttachments(requestMessages.flatMap((item) => item.attachments || []), currentAttachments);
        activeApiAgentController = controller;
        addLog("开始请求", { model: modelOptionLabel(config, selectedModel), messages: requestMessages.length });
        try {
            await runApiAgent({
                config,
                model: selectedModel,
                messages: [...requestMessages.slice(0, -1), userMessage],
                tools: API_AGENT_TOOLS,
                signal: controller.signal,
                executeTool: (call, input) => executeWithConfirmation(call, input, toolAttachments),
                onAssistantStart: (item) => addMessage({ id: item.id, role: "assistant", title: "API Agent", text: "", streamId: item.id }),
                onAssistantDelta: (id, delta) => updateChatMessage(id, (item) => ({ ...item, text: `${item.text}${delta}` })),
                onAssistantDone: (item) => {
                    if (item.content) updateChatMessage(item.id, (current) => ({ ...current, text: item.content, streamId: undefined }));
                    else setState({ messages: useApiAgentStore.getState().messages.filter((message) => message.id !== item.id) });
                },
                onToolStart: (call, input) => {
                    addLog(`调用${toolName(call.name)}`, input);
                    addMessage({ id: `api-tool-${call.id}`, role: "tool", title: toolName(call.name), text: `正在${toolName(call.name)}…`, detail: toolCallDetail(call.name, input, "inProgress") });
                },
                onToolDone: (call, result, toolError) => {
                    updateChatMessage(`api-tool-${call.id}`, (item) => ({ ...item, text: toolError || `${toolName(call.name)}完成`, detail: toolCallDetail(call.name, result, toolError ? "failed" : "completed") }));
                    addLog(toolError ? `${toolName(call.name)}失败` : `${toolName(call.name)}完成`, toolError || result);
                },
                onMessage: (item) => setState({ protocolMessages: [...useApiAgentStore.getState().protocolMessages, item] }),
            });
            await persist(sessionId, title, createdAt);
            addMessage({ id: `${runStatusId}-done`, role: "system", text: "任务已完成" });
            addLog("本轮完成", { sessionId });
        } catch (cause) {
            const currentMessages = useApiAgentStore.getState().messages;
            const partial = [...currentMessages].reverse().find((item) => item.streamId && item.text);
            if (partial && !useApiAgentStore.getState().protocolMessages.some((item) => item.id === partial.id)) setState({ protocolMessages: [...useApiAgentStore.getState().protocolMessages, { id: partial.id, role: "assistant", content: partial.text, createdAt: Date.now() }] });
            setState({ messages: currentMessages.filter((item) => item.text || !item.streamId) });
            const stopped = controller.signal.aborted || (cause instanceof DOMException && cause.name === "AbortError");
            const text = stopped ? "已停止本次请求" : cause instanceof Error ? cause.message : "API Agent 请求失败";
            addMessage({ id: `${runStatusId}-done`, role: "system", text: stopped ? "任务已停止" : "任务执行失败" });
            addMessage({ id: crypto.randomUUID(), role: stopped ? "system" : "error", title: stopped ? "已停止" : "错误", text });
            addLog(stopped ? "请求已停止" : "请求失败", text);
            setState({ error: stopped ? "" : text });
            await persist(sessionId, title, createdAt);
        } finally {
            if (activeApiAgentController === controller) activeApiAgentController = null;
            setState({ sending: false, waiting: false, pendingTool: null });
            pendingApiToolAction = null;
        }
    };

    const executeWithConfirmation = async (call: ApiAgentToolCall, input: Record<string, unknown>, currentAttachments: AgentAttachment[]) => {
        const run = () => executeApiAgentTool(call.name, input, navigate, currentAttachments);
        if (isApiAgentCanvasWriteTool(call.name) && useAgentStore.getState().canvasContext?.readOnly) return run();
        if (!useApiAgentStore.getState().confirmTools || !isApiAgentWriteTool(call.name)) return run();
        if (pendingApiToolAction) throw new Error("仍有待确认的画布工具调用");
        const tool: AgentPendingToolCall = { requestId: call.id, name: call.name, input: input as AgentPendingToolCall["input"] };
        setState({ pendingTool: tool });
        return await new Promise<unknown>((resolve, reject) => { pendingApiToolAction = { tool, run, resolve, reject }; });
    };

    const stopRun = () => {
        activeApiAgentController?.abort();
        const pending = pendingApiToolAction;
        if (pending) {
            pendingApiToolAction = null;
            setState({ pendingTool: null });
            pending.reject(new DOMException("请求已停止", "AbortError"));
        }
    };

    const approveTool = async () => {
        const pending = pendingApiToolAction;
        if (!pending) return;
        pendingApiToolAction = null;
        setState({ pendingTool: null });
        try { pending.resolve(await pending.run()); } catch (cause) { pending.reject(cause instanceof Error ? cause : new Error("工具执行失败")); }
    };

    const rejectTool = () => {
        const pending = pendingApiToolAction;
        if (!pending) return;
        pendingApiToolAction = null;
        setState({ pendingTool: null });
        pending.reject(new Error("用户取消了画布工具调用"));
    };

    const addFiles = async (files: FileList | File[] | null) => {
        const images = Array.from(files || []).filter((file) => file.type.startsWith("image/"));
        const next = await Promise.all(images.map(async (file) => {
            const dataUrl = await readDataUrl(file);
            const meta = await readImageMeta(dataUrl);
            return { id: randomId(), name: file.name, type: file.type, size: file.size, width: meta.width, height: meta.height, url: dataUrl, dataUrl };
        }));
        setState({ attachments: [...useApiAgentStore.getState().attachments, ...next] });
    };

    const threads: AgentThreadSummary[] = sessions.map((session) => ({ id: session.id, preview: session.title, name: session.title, createdAt: session.createdAt / 1000, updatedAt: session.updatedAt / 1000, source: "api" }));
    const content = (
        <>
            <AgentPanelTabs
                value={activeTab}
                theme={theme}
                leading={<div className="flex items-center gap-2 pr-1"><span className="grid size-8 place-items-center"><Bot className="size-4" /></span><div className="text-base font-semibold leading-5">Agent</div></div>}
                items={[
                    { value: "setup", label: "配置", icon: <Settings2 className="size-3.5" /> },
                    { value: "chat", label: "对话", icon: <MessageSquare className="size-3.5" /> },
                    { value: "history", label: "历史", icon: <History className="size-3.5" />, count: sessions.length },
                    { value: "log", label: "日志", icon: <Terminal className="size-3.5" />, count: eventLogs.length },
                ]}
                onChange={(activeTab) => { setState({ activeTab }); if (activeTab === "history") void refreshSessions(); }}
                right={<><Button size="small" type="text" disabled={busy} icon={<Plus className="size-3.5" />} onClick={startNewSession}>新对话</Button><Tooltip title="收起对话"><Button type="text" shape="circle" className="!h-8 !w-8 !min-w-8" style={{ color: theme.node.muted }} icon={<PanelRightClose className="size-4" />} onClick={closePanel} /></Tooltip></>}
            />
            {activeTab === "setup" ? (
                <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto px-4 py-5">
                    <div className="text-lg font-semibold">浏览器 API Agent</div>
                    <p className="mt-2 text-sm leading-6" style={{ color: theme.node.muted }}>无需启动本地 Agent。个人渠道由浏览器直接请求，管理员渠道继续使用服务端安全代理。</p>
                    <div className="mt-5 rounded-lg border p-4" style={{ borderColor: theme.node.stroke }}>
                        <div className="flex items-center gap-2 text-sm font-medium"><KeyRound className="size-4" />当前文本模型</div>
                        <div className="mt-3"><ModelPicker config={apiConfig} value={selectedModel} capability="text" fullWidth onChange={changeModel} onMissingConfig={() => openConfigDialog(false, "channels")} /></div>
                        <div className="mt-3 text-xs leading-5" style={{ color: theme.node.muted }}>{selectedModel ? channelDescription(config, selectedModel) : "尚未配置 OpenAI 兼容文本模型。"}</div>
                        <Button className="mt-4" type="primary" icon={<Settings2 className="size-4" />} onClick={() => openConfigDialog(false, "channels")}>配置个人 API 渠道</Button>
                    </div>
                    {error ? <div className="mt-4 rounded-lg border px-3 py-2 text-sm text-red-600" style={{ borderColor: "rgba(220,38,38,.35)" }}>{error}</div> : null}
                </div>
            ) : activeTab === "history" ? (
                <AgentHistoryView theme={theme} threads={threads} activeThreadId={activeSessionId} workspacePath="浏览器本地" loading={loadingSessions} busy={busy} connected onRefresh={() => void refreshSessions()} onNewThread={startNewSession} onResumeThread={(id) => void resumeSession(id)} onDeleteThreads={deleteSessions} />
            ) : activeTab === "log" ? (
                <AgentLogView logs={eventLogs} theme={theme} context={{ endpoint: resolveModelChannel(config, selectedModel).baseUrl || "未配置", connected: Boolean(selectedModel), enabled: true, activity: busy ? "API Agent 正在运行" : "就绪", waiting, sending, messages: messages.length, pendingTool: pendingTool?.name }} onClear={() => setState({ eventLogs: [] })} onCopied={(text) => message.success(text)} onCopyBlocked={(text) => message.warning(text)} />
            ) : (
                <>
                    <AgentChatTimeline messages={messages} theme={theme} pendingTool={pendingTool} pendingApprovals={[]} sending={sending} waiting={waiting} onRejectTool={rejectTool} onApproveTool={() => void approveTool()} onApprovalDecision={() => undefined} />
                    <AgentChatComposer prompt={prompt} attachments={attachments} disabled={!selectedModel} sending={busy} placeholder="询问 API Agent，或让它操作网站/画布" theme={theme} onPromptChange={(prompt) => setState({ prompt })} onSubmit={sendPrompt} onStop={stopRun} onAddFiles={addFiles} onRemoveAttachment={(id) => setState({ attachments: attachments.filter((item) => item.id !== id) })} confirmTools={confirmTools} onConfirmToolsChange={(confirmTools) => setState({ confirmTools })} left={<ModelPicker config={apiConfig} value={selectedModel} capability="text" className="!h-9 !min-w-0 !max-w-48 !border-0 !px-2.5 !shadow-none" onChange={changeModel} onMissingConfig={() => openConfigDialog(false, "channels")} />} />
                </>
            )}
        </>
    );
    return content;

    function changeModel(value: string) {
        localStorage.setItem("canvas-api-agent-model", value);
        if (!isAgentModelReady(config, value)) {
            setState({ model: value, activeTab: "setup", error: "所选个人渠道尚未填写 API Key，或接口地址不完整" });
            return;
        }
        setState({ model: value, error: "" });
    }
    function addLog(title: string, raw: unknown) {
        addEventLog({ id: randomId(), time: new Date().toLocaleTimeString(), title, text: logText(raw), raw });
    }
    function updateChatMessage(id: string, update: (item: AgentChatItem) => AgentChatItem) {
        setState({ messages: useApiAgentStore.getState().messages.map((item) => item.id === id ? update(item) : item) });
    }
}

function displayMessages(messages: ApiAgentMessage[]): AgentChatItem[] {
    return messages.flatMap((item) => {
        if (item.role === "user") return [{ id: item.id, role: "user" as const, text: item.content || `发送了 ${item.attachments?.length || 0} 张图片`, historyText: item.content, attachments: item.attachments }];
        if (item.role === "assistant") return item.content ? [{ id: item.id, role: "assistant" as const, title: "API Agent", text: item.content }] : [];
        const failed = item.content.includes('"ok":false');
        return [{ id: item.id, role: "tool" as const, title: toolName(item.name || ""), text: failed ? toolError(item.content) : `${toolName(item.name || "")}完成`, detail: { kind: "tool", status: failed ? "failed" : "completed" } }];
    });
}

function sessionTitle(text: string) { return text.replace(/\s+/g, " ").trim().slice(0, 30) || "新对话"; }
function mergeAttachments(previous: AgentAttachment[], current: AgentAttachment[]) { const items = new Map<string, AgentAttachment>(previous.map((item) => [item.id, item])); current.forEach((item) => items.set(item.id, item)); return [...items.values()]; }
function isAgentModelReady(config: AiConfig, model: string) { const channel = resolveModelChannel(config, model); return Boolean(model && channel.baseUrl.trim() && (channel.apiKey.trim() || channel.source === "remote")); }
function channelDescription(config: AiConfig, model: string) { const channel = resolveModelChannel(config, model); return `${channel.source === "remote" ? "管理员渠道 · 服务端代理" : "个人渠道 · 浏览器直连"} · ${modelOptionLabel(config, model)}`; }
function logText(value: unknown) { if (typeof value === "string") return value; try { return JSON.stringify(value); } catch { return String(value); } }
function toolError(value: string) { try { return String((JSON.parse(value) as { error?: string }).error || "工具执行失败"); } catch { return "工具执行失败"; } }
function readDataUrl(file: Blob) { return new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result || "")); reader.onerror = () => reject(reader.error || new Error("读取图片失败")); reader.readAsDataURL(file); }); }
async function historyAttachment(attachment: AgentAttachment) { const dataUrl = Math.max(attachment.width, attachment.height) > 512 ? await upscaleDataUrl(attachment.dataUrl, { targetLongEdge: 512, algorithm: "high" }) : attachment.dataUrl; return { ...attachment, dataUrl, url: dataUrl, size: dataUrl.length }; }

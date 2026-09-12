import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { App, Button, Empty, Input, Popconfirm, Spin, Tooltip } from "antd";
import { ArrowDownToLine, Bot, FileText, Library, MessageSquare, Plus, SendHorizonal, ThumbsDown, ThumbsUp, Trash2, User } from "lucide-react";
import { createKbConversation, deleteKbConversation, getKbConversation, listKbConversations, sendKbFeedback, streamKbMessage } from "../api";
import { KbMarkdown } from "../components/bits";
import type { KbCitation, KbConversation, KbMessage } from "../types";

interface ChatViewMessage extends KbMessage {
    streaming?: boolean;
}

export default function KnowledgeChatPage() {
    const { id } = useParams();
    const navigate = useNavigate();
    const { message } = App.useApp();
    const [conversations, setConversations] = useState<KbConversation[]>([]);
    const [messages, setMessages] = useState<ChatViewMessage[]>([]);
    const [input, setInput] = useState("");
    const [asking, setAsking] = useState(false);
    const [loadingConv, setLoadingConv] = useState(false);
    const [sidebarOpen, setSidebarOpen] = useState(true);
    const scrollRef = useRef<HTMLDivElement>(null);
    const abortRef = useRef<AbortController | null>(null);

    const loadConversations = useCallback(async () => {
        try {
            const result = await listKbConversations();
            setConversations(result.conversations);
        } catch { /* 列表失败不阻塞 */ }
    }, []);

    useEffect(() => { void loadConversations(); }, [loadConversations]);

    useEffect(() => {
        if (!id) {
            setMessages([]);
            return;
        }
        setLoadingConv(true);
        getKbConversation(id)
            .then((result) => setMessages(result.messages))
            .catch((error) => message.error(error instanceof Error ? error.message : "加载会话失败"))
            .finally(() => setLoadingConv(false));
    }, [id, message]);

    useEffect(() => {
        const el = scrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [messages]);

    const activeConversation = useMemo(() => conversations.find((item) => item.id === id), [conversations, id]);

    const ensureConversation = async (): Promise<string | null> => {
        if (id) return id;
        try {
            const { conversation } = await createKbConversation();
            navigate(`/knowledge/chat/${conversation.id}`, { replace: true });
            return conversation.id;
        } catch (error) {
            message.error(error instanceof Error ? error.message : "创建会话失败");
            return null;
        }
    };

    const ask = async () => {
        const content = input.trim();
        if (!content || asking) return;
        const convId = await ensureConversation();
        if (!convId) return;
        setInput("");
        setAsking(true);
        const userMessage: ChatViewMessage = { id: `local-${Date.now()}`, convId, role: "user", content, citations: null, feedback: null, createdAt: new Date().toISOString() };
        const placeholder: ChatViewMessage = { id: "pending", convId, role: "assistant", content: "", citations: null, feedback: null, createdAt: new Date().toISOString(), streaming: true };
        setMessages((current) => [...current, userMessage, placeholder]);
        const abort = new AbortController();
        abortRef.current = abort;
        try {
            await streamKbMessage(convId, content, {
                onDelta: (delta) => setMessages((current) => current.map((item) => (item.id === "pending" ? { ...item, content: item.content + delta } : item))),
                onDone: (saved, citations) => setMessages((current) => current.map((item) => (item.id === "pending" ? { ...saved, citations: saved.citations ?? citations } : item))),
                onError: (error) => setMessages((current) => current.map((item) => (item.id === "pending" ? { ...item, content: item.content || `（${error}）`, streaming: false } : item))),
            }, abort.signal);
            void loadConversations();
        } catch (error) {
            if (error instanceof Error && error.name === "AbortError") return;
            const text = error instanceof Error ? error.message : "请求失败";
            setMessages((current) => current.map((item) => (item.id === "pending" ? { ...item, content: `（${text}）`, streaming: false } : item)));
        } finally {
            abortRef.current = null;
            setAsking(false);
        }
    };

    const newChat = () => {
        abortRef.current?.abort();
        setMessages([]);
        setInput("");
        navigate("/knowledge/chat");
    };

    const removeConversation = async (convId: string) => {
        try {
            await deleteKbConversation(convId);
            if (convId === id) newChat();
            void loadConversations();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "删除失败");
        }
    };

    const feedback = async (item: ChatViewMessage, value: 1 | -1) => {
        if (!item.id || item.id.startsWith("local")) return;
        try {
            await sendKbFeedback(item.id, value);
            setMessages((current) => current.map((msg) => (msg.id === item.id ? { ...msg, feedback: value } : msg)));
        } catch (error) {
            message.error(error instanceof Error ? error.message : "反馈失败");
        }
    };

    return (
        <main className="flex h-full bg-background text-foreground">
            <aside className={`shrink-0 flex-col border-r border-border ${sidebarOpen ? "flex w-60" : "hidden"}`}>
                <div className="flex items-center gap-2 border-b border-border px-3 py-3">
                    <Button type="primary" icon={<Plus className="size-4" />} className="flex-1" onClick={newChat}>新会话</Button>
                </div>
                <div className="flex-1 overflow-y-auto p-2">
                    {conversations.map((item) => (
                        <div
                            key={item.id}
                            className={`group mb-1 flex cursor-pointer items-center gap-1 rounded-md px-2 py-2 text-sm transition hover:bg-muted ${item.id === id ? "bg-muted font-medium" : ""}`}
                            onClick={() => navigate(`/knowledge/chat/${item.id}`)}
                        >
                            <MessageSquare className="size-3.5 shrink-0 text-muted-foreground" />
                            <span className="min-w-0 flex-1 truncate">{item.title}</span>
                            <Popconfirm title="删除该会话？" onConfirm={() => void removeConversation(item.id)}>
                                <Button
                                    size="small"
                                    type="text"
                                    className="!hidden shrink-0 group-hover:!inline-flex"
                                    icon={<Trash2 className="size-3.5" />}
                                    onClick={(event) => event.stopPropagation()}
                                />
                            </Popconfirm>
                        </div>
                    ))}
                    {!conversations.length && <p className="px-2 py-6 text-center text-xs text-muted-foreground">暂无会话</p>}
                </div>
            </aside>

            <section className="flex min-w-0 flex-1 flex-col">
                <header className="flex items-center gap-3 border-b border-border px-4 py-3">
                    <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                        <Library className="size-4" />
                    </span>
                    <div className="min-w-0">
                        <h1 className="truncate text-sm font-semibold">{activeConversation?.title || "知识库 AI 问答"}</h1>
                        <p className="text-xs text-muted-foreground">基于全员沉淀的经验综合生成，答案附引用来源</p>
                    </div>
                    <Button className="ml-auto" size="small" onClick={() => setSidebarOpen((open) => !open)}>{sidebarOpen ? "收起列表" : "会话列表"}</Button>
                </header>

                <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4">
                    <Spin spinning={loadingConv}>
                        {!messages.length && !loadingConv ? (
                            <Empty description="直接向知识库提问，例如：客户退款的完整流程是什么？" className="py-24" />
                        ) : (
                            <ul className="mx-auto max-w-3xl space-y-4">
                                {messages.map((item) => (
                                    <li key={item.id} className={`flex gap-3 ${item.role === "user" ? "justify-end" : ""}`}>
                                        {item.role === "assistant" && (
                                            <span className="mt-1 grid size-7 shrink-0 place-items-center rounded-full bg-primary/10 text-primary"><Bot className="size-4" /></span>
                                        )}
                                        <div className={`min-w-0 max-w-[85%] rounded-lg px-4 py-3 ${item.role === "user" ? "bg-primary text-primary-foreground" : "border border-border bg-card"}`}>
                                            {item.role === "user" ? (
                                                <p className="whitespace-pre-wrap text-sm leading-6">{item.content}</p>
                                            ) : (
                                                <>
                                                    {item.streaming && !item.content ? (
                                                        <span className="text-sm text-muted-foreground">检索知识库并生成回答…</span>
                                                    ) : (
                                                        <KbMarkdown content={item.content} />
                                                    )}
                                                    {item.streaming && item.content && <span className="mt-1 inline-block h-4 w-2 animate-pulse bg-primary align-text-bottom" />}
                                                    {!!item.citations?.length && (
                                                        <div className="mt-3 border-t border-border pt-2">
                                                            <p className="mb-1.5 flex items-center gap-1 text-xs text-muted-foreground"><FileText className="size-3.5" />引用来源</p>
                                                            <div className="flex flex-wrap gap-1.5">
                                                                {item.citations.map((citation: KbCitation, index) => (
                                                                    <Tooltip key={citation.chunkId} title={`${citation.heading ? `# ${citation.heading} — ` : ""}${citation.excerpt}`}>
                                                                        <Link to={`/knowledge/posts/${citation.postId}`} className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs text-muted-foreground hover:border-primary hover:text-primary">
                                                                            <span className="font-medium">[{index + 1}]</span>
                                                                            <span className="max-w-40 truncate">{citation.title}</span>
                                                                        </Link>
                                                                    </Tooltip>
                                                                ))}
                                                            </div>
                                                        </div>
                                                    )}
                                                    {item.role === "assistant" && !item.streaming && item.id !== "pending" && (
                                                        <div className="mt-2 flex items-center gap-1 border-t border-border pt-2">
                                                            <span className="text-xs text-muted-foreground">回答有用吗？</span>
                                                            <Button size="small" type="text" icon={<ThumbsUp className={`size-3.5 ${item.feedback === 1 ? "text-primary" : ""}`} />} onClick={() => void feedback(item, 1)} />
                                                            <Button size="small" type="text" icon={<ThumbsDown className={`size-3.5 ${item.feedback === -1 ? "text-primary" : ""}`} />} onClick={() => void feedback(item, -1)} />
                                                            <Link to="/knowledge/posts/new" state={{ title: `经验沉淀：${(activeConversation?.title || "问答整理").slice(0, 40)}`, content: `## 问题\n\n${messages.filter((m) => m.role === "user").map((m) => `- ${m.content}`).join("\n")}\n\n## 结论\n\n${item.content}\n` }}>
                                                                <Button size="small" type="text" icon={<ArrowDownToLine className="size-3.5" />}>沉淀为帖子</Button>
                                                            </Link>
                                                        </div>
                                                    )}
                                                </>
                                            )}
                                        </div>
                                        {item.role === "user" && (
                                            <span className="mt-1 grid size-7 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground"><User className="size-4" /></span>
                                        )}
                                    </li>
                                ))}
                            </ul>
                        )}
                    </Spin>
                </div>

                <footer className="border-t border-border px-4 py-3">
                    <div className="mx-auto flex max-w-3xl items-end gap-2">
                        <Input.TextArea
                            value={input}
                            onChange={(event) => setInput(event.target.value)}
                            onKeyDown={(event) => {
                                if (event.key === "Enter" && !event.shiftKey) {
                                    event.preventDefault();
                                    void ask();
                                }
                            }}
                            placeholder="输入问题，Enter 发送，Shift+Enter 换行"
                            autoSize={{ minRows: 1, maxRows: 6 }}
                        />
                        <Button type="primary" icon={<SendHorizonal className="size-4" />} loading={asking} disabled={!input.trim()} onClick={() => void ask()}>发送</Button>
                    </div>
                </footer>
            </section>
        </main>
    );
}

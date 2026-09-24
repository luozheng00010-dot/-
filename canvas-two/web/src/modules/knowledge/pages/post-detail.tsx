import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { App, Button, Empty, Input, Popconfirm, Spin } from "antd";
import { ArrowLeft, CornerDownRight, Eye, Library, MessagesSquare, PenSquare, ShieldCheck, Trash2 } from "lucide-react";
import { useAuthStore } from "@/stores/use-auth-store";
import { StatusBadge } from "@/components/ui/status-badge";
import { addKbComment, archiveKbPost, getKbPost } from "../api";
import { KbMarkdown, OfficialBadge, PostTypeBadge } from "../components/bits";
import type { KbComment, KbPostCard, KbPostDetail } from "../types";

export default function KnowledgePostDetailPage() {
    const { id } = useParams();
    const { message } = App.useApp();
    const navigate = useNavigate();
    const user = useAuthStore((state) => state.user);
    const [post, setPost] = useState<KbPostDetail | null>(null);
    const [comments, setComments] = useState<KbComment[]>([]);
    const [related, setRelated] = useState<KbPostCard[]>([]);
    const [loading, setLoading] = useState(true);
    const [commentText, setCommentText] = useState("");
    const [replyTo, setReplyTo] = useState<KbComment | null>(null);
    const [submitting, setSubmitting] = useState(false);

    const load = useCallback(async () => {
        if (!id) return;
        setLoading(true);
        try {
            const result = await getKbPost(id);
            setPost(result.post);
            setComments(result.comments);
            setRelated(result.related);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "加载失败");
        } finally {
            setLoading(false);
        }
    }, [id, message]);

    useEffect(() => { void load(); }, [load]);

    const canManage = useMemo(() => !!post && !!user && (user.id === post.author.id || user.role === "admin"), [post, user]);

    const submitComment = async () => {
        if (!post || !commentText.trim()) return;
        setSubmitting(true);
        try {
            const result = await addKbComment(post.id, { content: commentText.trim(), ...(replyTo ? { parentId: replyTo.id } : {}) });
            setComments((current) => [...current, result.comment]);
            setCommentText("");
            setReplyTo(null);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "评论失败");
        } finally {
            setSubmitting(false);
        }
    };

    const archive = async () => {
        if (!post) return;
        try {
            await archiveKbPost(post.id);
            message.success("帖子已归档");
            navigate("/knowledge/posts");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "归档失败");
        }
    };

    return (
        <main className="flex h-full flex-col overflow-y-auto bg-background text-foreground">
            <header className="flex items-center gap-3 border-b border-border px-6 py-4">
                <Button type="text" icon={<ArrowLeft className="size-4" />} onClick={() => navigate(-1)}>返回</Button>
                <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-violet-500/10 text-violet-600 dark:text-violet-400">
                    <Library className="size-5" />
                </span>
                <div className="min-w-0">
                    <h1 className="truncate text-base font-semibold tracking-tight">{post?.title || "帖子详情"}</h1>
                    <p className="text-xs text-muted-foreground">公司知识库</p>
                </div>
                <div className="ml-auto flex shrink-0 items-center gap-2">
                    {canManage && post?.status !== "archived" && (
                        <>
                            <Button icon={<PenSquare className="size-4" />} onClick={() => navigate(`/knowledge/posts/${post?.id}/edit`)}>编辑</Button>
                            <Popconfirm title="归档后帖子不再展示，确认归档？" onConfirm={() => void archive()}>
                                <Button danger icon={<Trash2 className="size-4" />}>归档</Button>
                            </Popconfirm>
                        </>
                    )}
                </div>
            </header>

            <Spin spinning={loading}>
                {post && (
                    <div className="mx-auto grid w-full max-w-5xl flex-1 gap-6 px-6 py-6 lg:grid-cols-[1fr_240px]">
                        <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                                <PostTypeBadge type={post.type} />
                                {post.official && <OfficialBadge />}
                                {post.status !== "published" && <StatusBadge tone="warning" label="未发布" />}
                                {post.tags.map((tag) => <span key={tag} className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{tag}</span>)}
                            </div>
                            <h2 className="mt-3 text-xl font-semibold leading-8 tracking-tight">{post.title}</h2>
                            <div className="mt-2 flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
                                <span className="inline-flex items-center gap-1"><ShieldCheck className="size-3.5" />{post.author.username}</span>
                                {post.category && <span>{post.category.name}</span>}
                                <span>发布于 {new Date(post.createdAt).toLocaleString("zh-CN")}</span>
                                <span className="inline-flex items-center gap-0.5"><Eye className="size-3.5" />{post.viewCount}</span>
                            </div>

                            <article className="mt-6 rounded-xl border border-border bg-card px-6 py-5">
                                <KbMarkdown content={post.content} />
                            </article>

                            <section className="mt-8">
                                <h3 className="flex items-center gap-2 text-sm font-semibold">
                                    <MessagesSquare className="size-4" />
                                    评论（{comments.length}）
                                </h3>
                                <div className="mt-3 rounded-xl border border-border bg-card px-4 py-3">
                                    {replyTo && (
                                        <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
                                            <CornerDownRight className="size-3.5" />
                                            回复 {replyTo.author.username}：{replyTo.content.slice(0, 40)}
                                            <Button size="small" type="link" onClick={() => setReplyTo(null)}>取消</Button>
                                        </div>
                                    )}
                                    <Input.TextArea
                                        rows={3}
                                        value={commentText}
                                        placeholder="分享你的经验或补充…"
                                        onChange={(event) => setCommentText(event.target.value)}
                                    />
                                    <div className="mt-2 flex justify-end">
                                        <Button type="primary" loading={submitting} disabled={!commentText.trim()} onClick={() => void submitComment()}>发表评论</Button>
                                    </div>
                                </div>
                                <ul className="mt-4 space-y-3">
                                    {comments.map((comment) => {
                                        const parent = comment.parentId ? comments.find((item) => item.id === comment.parentId) : null;
                                        return (
                                            <li key={comment.id} className="rounded-xl border border-border bg-card px-4 py-3">
                                                <div className="flex items-center gap-2.5 text-xs text-muted-foreground">
                                                    <span className="grid size-6 shrink-0 place-items-center rounded-full bg-violet-500/10 text-[11px] font-semibold text-violet-600 dark:text-violet-400">
                                                        {comment.author.username.slice(0, 1).toUpperCase()}
                                                    </span>
                                                    <span className="font-medium text-foreground">{comment.author.username}</span>
                                                    <span>{new Date(comment.createdAt).toLocaleString("zh-CN")}</span>
                                                    <Button size="small" type="link" className="ml-auto" onClick={() => setReplyTo(comment)}>回复</Button>
                                                </div>
                                                {parent && (
                                                    <div className="mt-2 rounded bg-muted px-3 py-2 text-xs text-muted-foreground">
                                                        {parent.author.username}：{parent.content.slice(0, 80)}
                                                    </div>
                                                )}
                                                <p className="mt-2 whitespace-pre-wrap text-sm leading-6">{comment.content}</p>
                                            </li>
                                        );
                                    })}
                                    {!comments.length && <Empty description="还没有评论" image={Empty.PRESENTED_IMAGE_SIMPLE} />}
                                </ul>
                            </section>
                        </div>

                        <aside className="hidden lg:block">
                            <div className="sticky top-6 rounded-xl border border-border bg-card px-4 py-3">
                                <h3 className="text-sm font-semibold">相关帖子</h3>
                                <ul className="mt-3 space-y-2">
                                    {related.map((item) => (
                                        <li key={item.id}>
                                            <Link to={`/knowledge/posts/${item.id}`} className="line-clamp-2 text-xs leading-5 text-muted-foreground hover:text-primary">
                                                {item.title}
                                            </Link>
                                        </li>
                                    ))}
                                    {!related.length && <li className="text-xs text-muted-foreground">暂无相关帖子</li>}
                                </ul>
                            </div>
                        </aside>
                    </div>
                )}
            </Spin>
        </main>
    );
}

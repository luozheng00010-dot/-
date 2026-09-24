import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { App, Button, Empty, Input, Pagination, Segmented, Select, Spin } from "antd";
import { Eye, Library, MessageSquare, PenSquare, RefreshCw } from "lucide-react";
import { useAuthStore } from "@/stores/use-auth-store";
import { PageHeader } from "@/components/ui/page-header";
import { listKbCategories, listKbPosts, pinKbPost } from "../api";
import { IndexStatusTag, OfficialBadge, PostTypeBadge } from "../components/bits";
import type { KbCategory, KbPostCard, KbPostType } from "../types";

export default function KnowledgePostsPage() {
    const { message } = App.useApp();
    const navigate = useNavigate();
    const user = useAuthStore((state) => state.user);
    const [params, setParams] = useSearchParams();
    const [categories, setCategories] = useState<KbCategory[]>([]);
    const [items, setItems] = useState<KbPostCard[]>([]);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(true);
    const [keyword, setKeyword] = useState(params.get("keyword") || "");

    const scope = (params.get("scope") as "all" | "mine") || "all";
    const category = params.get("category") || "";
    const type = (params.get("type") as KbPostType) || "";
    const sort = (params.get("sort") as "latest" | "hottest") || "latest";
    const page = Number(params.get("page") || 1);

    const updateParams = (patch: Record<string, string>) => {
        const next = new URLSearchParams(params);
        for (const [key, value] of Object.entries(patch)) {
            if (value) next.set(key, value);
            else next.delete(key);
        }
        if (!("page" in patch)) next.delete("page");
        setParams(next, { replace: true });
    };

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const result = await listKbPosts({ scope, category: category || undefined, type: type || undefined, sort, keyword: params.get("keyword") || undefined, page, pageSize: 10 });
            setItems(result.items);
            setTotal(result.total);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "加载失败");
        } finally {
            setLoading(false);
        }
    }, [scope, category, type, sort, page, params, message]);

    useEffect(() => { void load(); }, [load]);
    useEffect(() => { listKbCategories().then((result) => setCategories(result.categories)).catch(() => undefined); }, []);

    const toggleOfficial = async (post: KbPostCard) => {
        try {
            await pinKbPost(post.id, !post.official);
            setItems((current) => current.map((item) => (item.id === post.id ? { ...item, official: !post.official } : item)));
        } catch (error) {
            message.error(error instanceof Error ? error.message : "操作失败");
        }
    };

    return (
        <main className="flex h-full flex-col overflow-y-auto bg-background text-foreground">
            <PageHeader
                icon={Library}
                tone="bg-violet-500/10 text-violet-600 dark:text-violet-400"
                title="公司知识库"
                description="经验沉淀、流程共享与语义检索"
                actions={<>
                    <Button icon={<RefreshCw className="size-4" />} onClick={() => void load()}>刷新</Button>
                    <Button type="primary" icon={<PenSquare className="size-4" />} onClick={() => navigate("/knowledge/posts/new")}>发帖</Button>
                </>}
            />

            <div className="flex flex-wrap items-center gap-2 border-b border-border px-6 py-3">
                <Input.Search
                    allowClear
                    defaultValue={keyword}
                    placeholder="搜索标题 / 内容"
                    className="w-60"
                    onSearch={(value) => { setKeyword(value); updateParams({ keyword: value.trim() }); }}
                />
                <Select
                    allowClear
                    placeholder="分类"
                    className="w-40"
                    value={category || undefined}
                    options={categories.map((item) => ({ value: item.id, label: `${item.name}（${item.postCount ?? 0}）` }))}
                    onChange={(value) => updateParams({ category: value || "" })}
                />
                <span className="mx-1 hidden h-5 w-px bg-border sm:block" />
                <Segmented
                    size="small"
                    value={type || "all"}
                    options={[{ value: "all", label: "全部类型" }, { value: "insight", label: "心得" }, { value: "workflow", label: "流程" }, { value: "qa", label: "问答" }]}
                    onChange={(value) => updateParams({ type: value === "all" ? "" : String(value) })}
                />
                <Segmented
                    size="small"
                    value={sort}
                    options={[{ value: "latest", label: "最新" }, { value: "hottest", label: "最热" }]}
                    onChange={(value) => updateParams({ sort: String(value) })}
                />
                <Segmented
                    size="small"
                    value={scope}
                    options={[{ value: "all", label: "全部" }, { value: "mine", label: "我发布的" }]}
                    onChange={(value) => updateParams({ scope: String(value) })}
                />
            </div>

            <section className="mx-auto w-full max-w-4xl flex-1 px-6 py-4">
                <Spin spinning={loading}>
                    {!items.length && !loading ? (
                        <Empty description={params.get("keyword") ? "没有匹配的帖子" : "还没有帖子，来发第一篇吧"} className="py-16" />
                    ) : (
                        <ul className="space-y-2.5">
                            {items.map((post) => (
                                <li key={post.id} className="rounded-xl border border-border bg-card px-4 py-3.5 transition hover:border-primary/40 hover:shadow-sm">
                                    <div className="flex items-center gap-2">
                                        <PostTypeBadge type={post.type} />
                                        {post.official && <OfficialBadge />}
                                        <Link to={`/knowledge/posts/${post.id}`} className="min-w-0 truncate text-sm font-medium hover:text-primary">{post.title}</Link>
                                    </div>
                                    <p className="mt-1.5 line-clamp-2 text-xs leading-5 text-muted-foreground">{post.excerpt}</p>
                                    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                                        <span className="font-medium text-foreground/80">{post.author.username}</span>
                                        {post.category && <span>{post.category.name}</span>}
                                        <span>{new Date(post.updatedAt).toLocaleString("zh-CN")}</span>
                                        <span className="inline-flex items-center gap-0.5"><Eye className="size-3.5" />{post.viewCount}</span>
                                        <span className="inline-flex items-center gap-0.5"><MessageSquare className="size-3.5" />{post.commentCount}</span>
                                        {post.tags.map((tag) => <span key={tag} className="rounded-full bg-muted px-2 py-0.5">{tag}</span>)}
                                        <span className="ml-auto flex items-center gap-3">
                                            {scope === "mine" && <IndexStatusTag status={post.indexStatus} />}
                                            {user?.role === "admin" && (
                                                <Button size="small" type="text" onClick={() => void toggleOfficial(post)}>
                                                    {post.official ? "取消官方" : "标为官方"}
                                                </Button>
                                            )}
                                        </span>
                                    </div>
                                </li>
                            ))}
                        </ul>
                    )}
                </Spin>
                <div className="flex justify-end py-4">
                    <Pagination current={page} total={total} pageSize={10} onChange={(next) => updateParams({ page: String(next) })} hideOnSinglePage />
                </div>
            </section>
        </main>
    );
}

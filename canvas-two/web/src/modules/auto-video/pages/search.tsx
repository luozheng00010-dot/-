import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Alert, App, Button, Checkbox, Input, Modal, Select } from "antd";
import { Clapperboard, Copy, Film, FolderOpen, ScanSearch } from "lucide-react";
import { listLibraryOptions, localVideoUrl, type LibraryOption } from "@/services/local-materials";
import { PageHeader } from "@/components/ui/page-header";
import { semanticApi } from "../semantic-api";

type SearchItem = { id: string; fileName: string; duration: number; thumbnail: string | null; score: number; grade?: string; reason?: string; keyword?: boolean };
const AMBER_TONE = "bg-amber-500/10 text-amber-600 dark:text-amber-400";
const scoreTone = (s: number) => s >= 70 ? "bg-emerald-500/90 text-white" : s >= 45 ? "bg-amber-500/90 text-white" : "bg-black/55 text-white";

export default function AutoVideoSearch() {
    const { message } = App.useApp();
    const [skus, setSkus] = useState<LibraryOption[]>([]);
    const [skuId, setSkuId] = useState<string>();
    const [query, setQuery] = useState("");
    const [items, setItems] = useState<SearchItem[]>([]);
    const [refine, setRefine] = useState(false);
    const [searched, setSearched] = useState(false);
    const [busy, setBusy] = useState(false), [error, setError] = useState("");
    const [preview, setPreview] = useState<SearchItem>();
    const search = useCallback(async () => {
        if (!skuId) { message.warning("请先选择货号"); return; }
        if (!query.trim()) { message.warning("请填写要查询的画面效果"); return; }
        setBusy(true);
        setError("");
        try {
            const result = await semanticApi<{ items: SearchItem[] }>("/materials/search", { skuId, query: query.trim(), refine });
            setItems(result.items);
            setSearched(true);
        } catch (e) { setError(e instanceof Error ? e.message : "查询失败"); }
        finally { setBusy(false); }
    }, [skuId, query, refine, message]);
    useEffect(() => { listLibraryOptions("skus").then(setSkus).catch(() => undefined); }, []);
    async function copyName(fileName: string) {
        try { await navigator.clipboard.writeText(fileName); message.success("已复制名称"); }
        catch { message.error("复制失败，请手动选择复制"); }
    }
    return (
        <main className="flex h-full min-h-0 flex-col bg-background text-foreground">
            <PageHeader
                icon={ScanSearch}
                tone={AMBER_TONE}
                title="画面查询"
                description="按画面语义在已索引素材中检索，结果越靠前越相关"
                actions={<>
                    <Link to="/auto-video"><Button type="text" icon={<Clapperboard className="size-4" />}>剪辑工作台</Button></Link>
                    <Link to="/auto-video/materials"><Button type="text" icon={<FolderOpen className="size-4" />}>素材库</Button></Link>
                </>}
            />

            <div className="flex-1 overflow-y-auto px-6 py-5">
                <div className="mx-auto w-full max-w-6xl">
                    <div className="rounded-xl border border-border bg-card p-4">
                        <div className="flex flex-wrap items-center gap-2">
                            <Select showSearch placeholder="选择货号" value={skuId} options={skus.map((s) => ({ value: s.id, label: s.name }))} onChange={setSkuId} className="w-52" />
                            <Input.Search value={query} onChange={(e) => setQuery(e.target.value)} onSearch={() => void search()} enterButton="查询" placeholder="描述要查询的画面，如：手拂过内裤" className="min-w-64 flex-1" loading={busy} />
                            <Checkbox checked={refine} onChange={(e) => setRefine(e.target.checked)} title="由文案模型对结果逐条评估排序，更准但多等几秒，并消耗少量 token">LLM 精排</Checkbox>
                        </div>
                        <p className="mt-2 text-xs text-muted-foreground">点击缩略图预览，名称可复制；左上角为相关度（勾选 LLM 精排时为模型评分，否则为向量相似度）。</p>
                    </div>

                    {error && <Alert type="error" title={error} className="mt-4" />}
                    <div className="mt-4">
                        {busy ? (
                            <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
                                {Array.from({ length: 6 }).map((_, i) => <div key={i} className="aspect-video animate-pulse rounded-xl bg-muted" />)}
                            </div>
                        ) : searched && !items.length ? (
                            <div className="mt-20 flex flex-col items-center gap-2.5 text-center">
                                <span className={`grid size-12 place-items-center rounded-xl ${AMBER_TONE}`}><Film className="size-6" /></span>
                                <p className="text-sm font-medium">没有匹配的素材</p>
                                <p className="text-xs text-muted-foreground">换个描述试试</p>
                            </div>
                        ) : (
                            <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
                                {items.map((item) => (
                                    <div key={item.id} className="relative overflow-hidden rounded-xl border border-border bg-card transition hover:border-primary/40 hover:shadow-sm">
                                        {item.thumbnail
                                            ? <img src={item.thumbnail} alt={item.fileName} className="aspect-video w-full cursor-pointer object-cover" onClick={() => setPreview(item)} />
                                            : <div className="flex aspect-video w-full cursor-pointer items-center justify-center bg-muted text-xs text-muted-foreground" onClick={() => setPreview(item)}>无缩略图</div>}
                                        <span className={`absolute left-1.5 top-1.5 rounded px-1.5 py-0.5 text-[11px] font-medium ${scoreTone(item.score)}`} title={item.reason ?? (refine ? "模型相关性评分" : "向量相似度")}>{item.score}</span>
                                        {item.keyword && <span className="absolute right-1.5 top-1.5 rounded bg-sky-500/90 px-1.5 py-0.5 text-[11px] font-medium text-white" title="标注关键词与查询词精确匹配">词</span>}
                                        <div className="flex items-center justify-between gap-1 px-2.5 py-2">
                                            <span className="truncate text-xs" title={item.fileName}>{item.fileName}</span>
                                            <Button size="small" type="text" icon={<Copy size={14} />} onClick={() => void copyName(item.fileName)} title="复制名称" />
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            </div>

            <Modal open={!!preview} title={preview?.fileName} footer={null} onCancel={() => setPreview(undefined)} destroyOnHidden width={800}>
                {preview && <>
                    <video key={preview.id} src={localVideoUrl(preview.id)} controls autoPlay className="max-h-[65vh] w-full rounded-lg" />
                    {preview.reason && <p className="mt-2 text-sm text-muted-foreground">匹配理由：{preview.reason}</p>}
                </>}
            </Modal>
        </main>
    );
}

import { useEffect, useMemo, useState } from "react";
import { App, Empty, Input, Modal, Pagination, Spin, Tag } from "antd";
import { Search } from "lucide-react";

import { cn } from "@/lib/utils";
import { ProductSelect } from "@/components/product-select";
import { imageThumbnailUrl } from "@/services/image-storage";
import { listAllProducts } from "@/services/products";
import { useAssetStore, type Asset } from "@/stores/use-asset-store";
import type { Product } from "@/types/product";

export type InsertAssetPayload = { kind: "text"; content: string; title: string } | { kind: "image"; dataUrl: string; title: string; storageKey?: string; productId?: string } | { kind: "video"; url: string; thumbnailUrl?: string; title: string; storageKey?: string; width?: number; height?: number };

type Props = {
    open: boolean;
    defaultTab?: string;
    onInsert: (payload: InsertAssetPayload) => void;
    onClose: () => void;
};

export function CanvasProductPickerModal({ open, ownerId, productId, onClose, onSelect }: { open: boolean; ownerId: string; productId?: string; onClose: () => void; onSelect: (product: Product) => void }) {
    const { message } = App.useApp();
    const [products, setProducts] = useState<Product[]>([]);
    const [selectedProductId, setSelectedProductId] = useState(productId || "");
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        if (!open || !ownerId) return;
        let cancelled = false;
        setSelectedProductId(productId || "");
        setLoading(true);
        listAllProducts({ owner: ownerId }).then((productResult) => {
            if (cancelled) return;
            setProducts(productResult.items.filter((item) => Boolean(item.resultImage)));
        }).catch((error) => !cancelled && message.error(error instanceof Error ? error.message : "商品加载失败")).finally(() => !cancelled && setLoading(false));
        return () => { cancelled = true; };
    }, [message, open, ownerId, productId]);

    const selected = products.find((item) => item.id === selectedProductId);
    return (
        <Modal title="选择商品" open={open} width={520} destroyOnHidden onCancel={onClose} onOk={() => { if (!selected) return message.warning("请选择已有商品"); onSelect(selected); onClose(); }} okText="继续到详情页复刻">
            {loading ? <div className="grid min-h-40 place-items-center"><Spin /></div> : <div className="space-y-3 py-2"><p className="text-sm text-muted-foreground">普通图片仅作为流程布局锚点，实际生成使用所选商品的四视角主图。</p><ProductSelect className="w-full" value={selectedProductId} products={products} onChange={setSelectedProductId} notFoundContent="当前画布所有者没有已完成的商品图" /></div>}
        </Modal>
    );
}

export function AssetPickerModal({ open, onInsert, onClose }: Props) {
    return (
        <Modal title="选择资产" open={open} onCancel={onClose} footer={null} width={860} destroyOnHidden styles={{ body: { padding: "0 24px 24px", minHeight: 480 } }}>
            <MyAssetsTab onInsert={onInsert} />
        </Modal>
    );
}

const PAGE_SIZE = 8;

const kindOptions = [
    { label: "全部", value: "all" },
    { label: "文本", value: "text" },
    { label: "图片", value: "image" },
    { label: "视频", value: "video" },
];

function PickerCard({ title, kind, cover, onClick }: { title: string; kind: string; cover: string; onClick: () => void }) {
    return (
        <button
            type="button"
            className="group relative cursor-pointer overflow-hidden rounded-lg border border-stone-200 bg-white text-left transition hover:border-stone-400 hover:shadow-md dark:border-stone-700 dark:bg-stone-900 dark:hover:border-stone-500"
            onClick={onClick}
        >
            {cover ? (
                <img src={cover} alt={title} loading="lazy" decoding="async" className="aspect-[4/3] w-full object-cover" />
            ) : (
                <div className="flex aspect-[4/3] items-center justify-center bg-stone-100 p-3 text-center text-xs leading-5 text-stone-500 dark:bg-stone-800 dark:text-stone-400">{title}</div>
            )}
            <div className="p-2.5">
                <div className="flex items-center justify-between gap-2">
                    <span className="line-clamp-1 text-xs font-medium text-stone-800 dark:text-stone-200">{title}</span>
                    <Tag className="m-0 shrink-0 text-[10px]">{kind === "image" ? "图片" : kind === "video" ? "视频" : "文本"}</Tag>
                </div>
            </div>
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-stone-950/0 text-sm font-medium text-white opacity-0 transition group-hover:bg-stone-950/55 group-hover:opacity-100">插入</div>
        </button>
    );
}

function MyAssetsTab({ onInsert }: { onInsert: (payload: InsertAssetPayload) => void }) {
    const assets = useAssetStore((state) => state.assets);
    const [keyword, setKeyword] = useState("");
    const [kindFilter, setKindFilter] = useState("all");
    const [page, setPage] = useState(1);

    const filtered = useMemo(() => {
        const query = keyword.trim().toLowerCase();
        return assets
            .filter((a) => a.kind === "text" || a.kind === "image" || a.kind === "video")
            .filter((a) => kindFilter === "all" || a.kind === kindFilter)
            .filter((a) => !query || [a.title, ...(a.tags || [])].join(" ").toLowerCase().includes(query));
    }, [assets, keyword, kindFilter]);

    const visible = useMemo(() => filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), [filtered, page]);

    useEffect(() => {
        const maxPage = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
        setPage((v) => Math.min(v, maxPage));
    }, [filtered.length]);

    const handleInsert = (asset: Asset) => {
        if (asset.kind === "text") {
            onInsert({ kind: "text", content: asset.data.content, title: asset.title });
        } else {
            onInsert(asset.kind === "video" ? { kind: "video", url: asset.data.url, thumbnailUrl: asset.coverUrl || asset.data.thumbnailUrl, storageKey: asset.data.storageKey, title: asset.title, width: asset.data.width, height: asset.data.height } : { kind: "image", dataUrl: asset.data.dataUrl, storageKey: asset.data.storageKey, title: asset.title });
        }
    };

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
                <Input
                    className="w-56"
                    size="small"
                    prefix={<Search className="size-3.5 text-stone-400" />}
                    placeholder="搜索资产"
                    value={keyword}
                    allowClear
                    onChange={(e) => {
                        setPage(1);
                        setKeyword(e.target.value);
                    }}
                />
                <div className="flex gap-1.5">
                    {kindOptions.map((opt) => (
                        <Tag.CheckableTag
                            key={opt.value}
                            checked={kindFilter === opt.value}
                            className={cn("prompt-filter-tag", kindFilter === opt.value && "is-active")}
                            onChange={() => {
                                setPage(1);
                                setKindFilter(opt.value);
                            }}
                        >
                            {opt.label}
                        </Tag.CheckableTag>
                    ))}
                </div>
            </div>

            {visible.length ? (
                <div className="grid grid-cols-4 gap-3">
                    {visible.map((asset) => (
                        <PickerCard key={asset.id} title={asset.title} kind={asset.kind} cover={asset.kind === "image" ? imageThumbnailUrl(asset.data.storageKey, asset.coverUrl || asset.data.dataUrl) : asset.kind === "video" ? asset.coverUrl || asset.data.thumbnailUrl : asset.coverUrl} onClick={() => handleInsert(asset)} />
                    ))}
                </div>
            ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有资产" className="py-12" />
            )}

            {filtered.length > PAGE_SIZE && (
                <div className="flex justify-center">
                    <Pagination size="small" current={page} pageSize={PAGE_SIZE} total={filtered.length} onChange={setPage} showSizeChanger={false} />
                </div>
            )}
        </div>
    );
}

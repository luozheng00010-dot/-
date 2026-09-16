import { useCallback, useEffect, useRef, useState } from "react";
import { App, Button, Empty, Input, Modal, Pagination, Popconfirm, Progress, Select, Spin, Switch, Tag, Tooltip, Upload } from "antd";
import type { UploadFile } from "antd";
import { Archive, Film, RefreshCw, Upload as UploadIcon, X } from "lucide-react";
import { createIngestBatch, getIngestBatch, listVideoCategories, listVideoMaterials, mediaContentUrl, updateVideoMaterial } from "../api";
import SkuSelect from "../components/sku-select";
import type { VideoCategory, VideoFailedMaterial, VideoIngestBatch, VideoMaterial, VideoTagStatus } from "../types";

/** 一次最多上传的文件数与每批分片大小 */
const MAX_FILES = 100;
const BATCH_SIZE = 20;
const PAGE_SIZE = 24;
/** 页面刷新后仍需要跟踪进度的批次 id 列表 */
const ACTIVE_BATCH_KEY = "video-edit:active-ingest-batches";

interface TrackedBatch {
    id: string;
    sku: string;
    batch: VideoIngestBatch;
    failedMaterials: VideoFailedMaterial[];
}

const tagStatusMeta: Record<VideoTagStatus, { label: string; dot: string; text: string }> = {
    pending: { label: "待打标", dot: "bg-muted-foreground/50", text: "text-muted-foreground" },
    processing: { label: "打标中", dot: "bg-blue-500 animate-pulse", text: "text-blue-600 dark:text-blue-400" },
    done: { label: "已打标", dot: "bg-emerald-500", text: "text-emerald-600 dark:text-emerald-400" },
    failed: { label: "打标失败", dot: "bg-red-500", text: "text-red-600 dark:text-red-400" },
};

function formatDuration(seconds: number) {
    return `${seconds.toFixed(1)}s`;
}

export default function VideoMaterialsPage() {
    const { message } = App.useApp();

    const [categories, setCategories] = useState<VideoCategory[]>([]);
    const [items, setItems] = useState<VideoMaterial[]>([]);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(true);

    const [skuKeyword, setSkuKeyword] = useState("");
    const [categoryId, setCategoryId] = useState<string | undefined>(undefined);
    const [tagStatus, setTagStatus] = useState<VideoTagStatus | undefined>(undefined);
    const [onlyProductVisible, setOnlyProductVisible] = useState(false);
    const [page, setPage] = useState(1);

    // ===== 批次进度跟踪（打标异步，轮询 5s 直到终态） =====
    const [tracked, setTracked] = useState<TrackedBatch[]>([]);
    const pollingRef = useRef(false);

    // ===== 批量上传弹窗 =====
    const [uploadOpen, setUploadOpen] = useState(false);
    const [uploadSku, setUploadSku] = useState("");
    const [uploadCategoryId, setUploadCategoryId] = useState<string | undefined>(undefined);
    const [uploadFiles, setUploadFiles] = useState<UploadFile[]>([]);
    const [submitting, setSubmitting] = useState(false);
    const [uploadPercent, setUploadPercent] = useState(0);

    const isGeneralCategory = categories.find((item) => item.id === uploadCategoryId)?.name === "通用";

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const result = await listVideoMaterials({
                sku: skuKeyword.trim() || undefined,
                categoryId,
                tagStatus,
                productVisible: onlyProductVisible || undefined,
                status: "active",
                page,
                pageSize: PAGE_SIZE,
            });
            setItems(result.items);
            setTotal(result.total);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "加载失败");
        } finally {
            setLoading(false);
        }
    }, [skuKeyword, categoryId, tagStatus, onlyProductVisible, page, message]);

    useEffect(() => { void load(); }, [load]);
    useEffect(() => {
        listVideoCategories()
            .then((result) => setCategories([...result.categories].sort((a, b) => a.sortOrder - b.sortOrder)))
            .catch(() => undefined);
    }, []);

    // 恢复上次未完成的批次进度
    useEffect(() => {
        let ids: unknown = null;
        try { ids = JSON.parse(localStorage.getItem(ACTIVE_BATCH_KEY) || "[]"); } catch { ids = null; }
        if (!Array.isArray(ids) || !ids.length) return;
        (async () => {
            const loaded: TrackedBatch[] = [];
            for (const id of ids) {
                if (typeof id !== "string") continue;
                try {
                    const result = await getIngestBatch(id);
                    loaded.push({ id, sku: result.batch.sku, batch: result.batch, failedMaterials: result.failedMaterials });
                } catch { /* 批次可能已清理，忽略 */ }
            }
            if (loaded.length) setTracked((current) => [...loaded, ...current.filter((item) => !loaded.some((batch) => batch.id === item.id))]);
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // 只持久化还在处理中的批次，终态批次刷新后不再出现
    useEffect(() => {
        const activeIds = tracked.filter((item) => item.batch.status === "processing").map((item) => item.id);
        localStorage.setItem(ACTIVE_BATCH_KEY, JSON.stringify(activeIds));
    }, [tracked]);

    const pollBatches = useCallback(async () => {
        if (pollingRef.current) return;
        const active = tracked.filter((item) => item.batch.status === "processing");
        if (!active.length) return;
        pollingRef.current = true;
        let finishedAny = false;
        try {
            for (const item of active) {
                try {
                    const result = await getIngestBatch(item.id);
                    setTracked((current) => current.map((entry) => (entry.id === item.id
                        ? { ...entry, batch: result.batch, failedMaterials: result.failedMaterials }
                        : entry)));
                    if (result.batch.status !== "processing") finishedAny = true;
                } catch { /* 单次查询失败下轮重试 */ }
            }
        } finally {
            pollingRef.current = false;
        }
        if (finishedAny) void load();
    }, [tracked, load]);

    useEffect(() => {
        const timer = setInterval(() => { void pollBatches(); }, 5000);
        return () => clearInterval(timer);
    }, [pollBatches]);

    const resetFilters = () => {
        setSkuKeyword("");
        setCategoryId(undefined);
        setTagStatus(undefined);
        setOnlyProductVisible(false);
        setPage(1);
    };

    const handleUploadCategoryChange = (value: string | undefined) => {
        setUploadCategoryId(value);
        const name = categories.find((item) => item.id === value)?.name;
        if (name === "通用") setUploadSku("通用");
        else if (uploadSku === "通用") setUploadSku("");
    };

    const submitUpload = async () => {
        const rawFiles = uploadFiles.flatMap((file) => (file.originFileObj ? [file.originFileObj as File] : []));
        if (!uploadCategoryId) {
            message.warning("请选择素材分类");
            return;
        }
        if (!isGeneralCategory && !uploadSku.trim()) {
            message.warning("请选择货号（可在下拉中新增）");
            return;
        }
        if (!rawFiles.length) {
            message.warning("请选择要上传的视频文件");
            return;
        }
        const finalSku = isGeneralCategory ? "通用" : uploadSku.trim();
        const chunks: File[][] = [];
        for (let index = 0; index < rawFiles.length; index += BATCH_SIZE) chunks.push(rawFiles.slice(index, index + BATCH_SIZE));
        setSubmitting(true);
        setUploadPercent(0);
        let uploaded = 0;
        try {
            for (const part of chunks) {
                const result = await createIngestBatch({ sku: finalSku, categoryId: uploadCategoryId, files: part });
                uploaded += part.length;
                setUploadPercent(Math.round((uploaded / rawFiles.length) * 100));
                setTracked((current) => [...current, { id: result.batch.id, sku: result.batch.sku, batch: result.batch, failedMaterials: [] }]);
            }
            message.success(`已提交 ${rawFiles.length} 个文件（${chunks.length} 个批次），正在后台打标`);
            setUploadFiles([]);
            setUploadOpen(false);
            setPage(1);
            void load();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "上传失败");
        } finally {
            setSubmitting(false);
            setUploadPercent(0);
        }
    };

    const archiveMaterial = async (material: VideoMaterial) => {
        try {
            await updateVideoMaterial(material.id, { status: "archived" });
            message.success("已归档");
            void load();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "操作失败");
        }
    };

    const dismissTracked = (id: string) => {
        setTracked((current) => current.filter((item) => item.id !== id));
    };

    return (
        <main className="flex h-full flex-col overflow-y-auto bg-background text-foreground">
            <header className="flex flex-wrap items-center gap-3 border-b border-border px-6 py-4">
                <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                    <Film className="size-5" />
                </span>
                <div className="min-w-0">
                    <h1 className="text-base font-semibold tracking-tight">素材库</h1>
                    <p className="text-xs text-muted-foreground">影棚视频按货号 + 分类入库，AI 自动打标</p>
                </div>
                <div className="ml-auto flex shrink-0 items-center gap-2">
                    <Button icon={<RefreshCw className="size-4" />} onClick={() => void load()}>刷新</Button>
                    <Button type="primary" icon={<UploadIcon className="size-4" />} onClick={() => setUploadOpen(true)}>批量上传</Button>
                </div>
            </header>

            <div className="flex flex-wrap items-center gap-2 border-b border-border px-6 py-3">
                <Input.Search
                    allowClear
                    placeholder="货号模糊搜索"
                    className="w-52"
                    onSearch={(value) => { setSkuKeyword(value); setPage(1); }}
                />
                <Select
                    allowClear
                    placeholder="分类"
                    className="w-36"
                    value={categoryId}
                    options={categories.map((item) => ({ value: item.id, label: item.name }))}
                    onChange={(value) => { setCategoryId(value); setPage(1); }}
                />
                <Select
                    allowClear
                    placeholder="打标状态"
                    className="w-36"
                    value={tagStatus}
                    options={[
                        { value: "pending", label: "待打标" },
                        { value: "processing", label: "打标中" },
                        { value: "done", label: "已打标" },
                        { value: "failed", label: "打标失败" },
                    ]}
                    onChange={(value) => { setTagStatus(value); setPage(1); }}
                />
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Switch size="small" checked={onlyProductVisible} onChange={(checked) => { setOnlyProductVisible(checked); setPage(1); }} />
                    仅看疑似露产品
                </span>
                <Button type="text" size="small" className="ml-auto" onClick={resetFilters}>重置筛选</Button>
            </div>

            <section className="mx-auto w-full max-w-7xl flex-1 px-6 py-4">
                {tracked.length > 0 && (
                    <ul className="mb-4 space-y-2">
                        {tracked.map((item) => {
                            const finished = item.batch.doneCount + item.batch.failedCount;
                            const percent = item.batch.totalCount ? Math.round((finished / item.batch.totalCount) * 100) : 0;
                            const processing = item.batch.status === "processing";
                            return (
                                <li key={item.id} className="rounded-lg border border-border bg-card px-4 py-2.5">
                                    <div className="flex items-center gap-2 text-xs">
                                        <span className="font-medium">打标批次</span>
                                        <Tag className="mr-0">{item.sku}</Tag>
                                        <span className="text-muted-foreground">
                                            {finished}/{item.batch.totalCount} 已完成
                                            {item.batch.failedCount > 0 && ` · ${item.batch.failedCount} 失败`}
                                        </span>
                                        <span className={processing ? tagStatusMeta.processing.text : item.batch.status === "failed" ? tagStatusMeta.failed.text : tagStatusMeta.done.text}>
                                            · {processing ? "打标中" : item.batch.status === "partial" ? "部分失败" : item.batch.status === "failed" ? "全部失败" : "已完成"}
                                        </span>
                                        {item.failedMaterials.length > 0 && (
                                            <Tooltip
                                                title={
                                                    <ul className="max-h-48 space-y-1 overflow-y-auto text-xs">
                                                        {item.failedMaterials.map((failed) => (
                                                            <li key={failed.id}>
                                                                {failed.fileName}：{failed.tagError || "未知错误"}
                                                            </li>
                                                        ))}
                                                    </ul>
                                                }
                                            >
                                                <span className="cursor-help underline decoration-dotted text-red-600 dark:text-red-400">失败明细</span>
                                            </Tooltip>
                                        )}
                                        <Button
                                            size="small"
                                            type="text"
                                            className="ml-auto"
                                            icon={<X className="size-3.5" />}
                                            onClick={() => dismissTracked(item.id)}
                                        />
                                    </div>
                                    <Progress
                                        percent={percent}
                                        size="small"
                                        showInfo={false}
                                        className="mb-0"
                                        status={item.batch.failedCount > 0 && !processing ? "exception" : undefined}
                                    />
                                </li>
                            );
                        })}
                    </ul>
                )}

                <Spin spinning={loading}>
                    {!items.length && !loading ? (
                        <Empty description="暂无素材，点右上角「批量上传」开始入库" className="py-16" />
                    ) : (
                        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
                            {items.map((material) => {
                                const meta = tagStatusMeta[material.tagStatus] || tagStatusMeta.pending;
                                return (
                                    <li key={material.id} className="group overflow-hidden rounded-lg border border-border bg-card transition hover:border-primary/40">
                                        <div className="relative aspect-[3/4] bg-muted">
                                            {material.thumbnailMediaId ? (
                                                <img
                                                    src={mediaContentUrl(material.thumbnailMediaId)}
                                                    alt={material.fileName}
                                                    loading="lazy"
                                                    className="size-full object-cover"
                                                />
                                            ) : (
                                                <span className="grid size-full place-items-center text-muted-foreground/40">
                                                    <Film className="size-8" />
                                                </span>
                                            )}
                                            <span className="absolute bottom-1.5 left-1.5 rounded bg-black/60 px-1.5 py-0.5 text-xs tabular-nums text-white">
                                                {formatDuration(material.duration)}
                                            </span>
                                            <Tag color="geekblue" className="absolute right-1.5 top-1.5 mr-0 max-w-[70%] truncate">{material.sku}</Tag>
                                            {material.productVisible === true && (
                                                <Tag color="gold" className="absolute left-1.5 top-1.5 mr-0">疑似露产品</Tag>
                                            )}
                                        </div>
                                        <div className="space-y-1.5 px-2.5 py-2">
                                            <div className="truncate text-xs font-medium" title={material.fileName}>{material.fileName}</div>
                                            {material.description && (
                                                <p className="line-clamp-1 text-xs text-muted-foreground" title={material.description}>{material.description}</p>
                                            )}
                                            <div className="flex items-center gap-1.5">
                                                <Tag className="mr-0 shrink-0">{material.categoryName}</Tag>
                                                {material.tagStatus === "failed" ? (
                                                    <Tooltip title={material.tagError || "打标失败"}>
                                                        <span className={`inline-flex shrink-0 cursor-help items-center gap-1 text-xs ${meta.text}`}>
                                                            <span className={`size-1.5 rounded-full ${meta.dot}`} />
                                                            {meta.label}
                                                        </span>
                                                    </Tooltip>
                                                ) : (
                                                    <span className={`inline-flex shrink-0 items-center gap-1 text-xs ${meta.text}`}>
                                                        <span className={`size-1.5 rounded-full ${meta.dot}`} />
                                                        {meta.label}
                                                    </span>
                                                )}
                                                <Popconfirm
                                                    title="归档素材"
                                                    description="归档后不再参与匹配，确定？"
                                                    okText="归档"
                                                    cancelText="取消"
                                                    onConfirm={() => void archiveMaterial(material)}
                                                >
                                                    <Button
                                                        size="small"
                                                        type="text"
                                                        className="ml-auto"
                                                        icon={<Archive className="size-3.5" />}
                                                    />
                                                </Popconfirm>
                                            </div>
                                        </div>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </Spin>
                <div className="flex justify-end py-4">
                    <Pagination
                        current={page}
                        total={total}
                        pageSize={PAGE_SIZE}
                        hideOnSinglePage
                        showTotal={(count) => `共 ${count} 条`}
                        onChange={(next) => setPage(next)}
                    />
                </div>
            </section>

            <Modal
                title="批量上传素材"
                open={uploadOpen}
                onCancel={() => { if (!submitting) setUploadOpen(false); }}
                width={560}
                footer={
                    <div className="flex items-center justify-end gap-2">
                        {submitting && <span className="mr-auto text-xs text-muted-foreground">正在分批上传（每批 {BATCH_SIZE} 个）…</span>}
                        <Button disabled={submitting} onClick={() => setUploadOpen(false)}>取消</Button>
                        <Button type="primary" loading={submitting} onClick={() => void submitUpload()}>开始上传</Button>
                    </div>
                }
            >
                <div className="space-y-4 pt-2">
                    <div className="flex items-center gap-3">
                        {isGeneralCategory ? (
                            // 分类=通用：货号固定为哨兵值并禁用（D3），只读展示更清晰
                            <Input className="flex-1" value="通用" disabled />
                        ) : (
                            <SkuSelect
                                className="flex-1"
                                placeholder="货号"
                                value={uploadSku || null}
                                disabled={submitting}
                                onChange={(name) => setUploadSku(name ?? "")}
                            />
                        )}
                        <Select
                            className="w-40"
                            placeholder="分类"
                            value={uploadCategoryId}
                            disabled={submitting}
                            options={categories.map((item) => ({ value: item.id, label: item.name }))}
                            onChange={(value) => handleUploadCategoryChange(value)}
                        />
                    </div>
                    {isGeneralCategory && (
                        <p className="text-xs text-muted-foreground">分类为「通用」时货号固定为"通用"，该类素材不露出产品，可被所有货号复用。</p>
                    )}
                    <Upload.Dragger
                        multiple
                        disabled={submitting}
                        accept="video/*"
                        fileList={uploadFiles}
                        beforeUpload={() => false}
                        onChange={({ fileList: next }) => {
                            let list = next.filter((file) => (file.type || file.originFileObj?.type || "").startsWith("video/"));
                            if (list.length !== next.length) message.warning("已忽略非视频文件");
                            if (list.length > MAX_FILES) {
                                message.warning(`一次最多上传 ${MAX_FILES} 个文件，超出部分已忽略`);
                                list = list.slice(0, MAX_FILES);
                            }
                            setUploadFiles(list);
                        }}
                    >
                        <p className="ant-upload-drag-icon"><UploadIcon className="size-8 text-muted-foreground" /></p>
                        <p className="ant-upload-text">点击或拖拽视频文件到此处</p>
                        <p className="ant-upload-hint">单个文件为 1~5 秒的单镜头视频，最多 {MAX_FILES} 个，将按每批 {BATCH_SIZE} 个分批上传</p>
                    </Upload.Dragger>
                    {submitting && <Progress percent={uploadPercent} size="small" className="mb-0" />}
                </div>
            </Modal>
        </main>
    );
}

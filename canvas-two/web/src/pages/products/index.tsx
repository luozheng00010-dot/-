import { ChevronLeft, ChevronRight, Download, Edit3, ImagePlus, LoaderCircle, PackageOpen, Plus, RefreshCw, Search, Trash2, Upload, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { App, Button, Empty, Image, Input, Modal, Select, Spin, Tag } from "antd";
import { saveAs } from "file-saver";
import { nanoid } from "nanoid";

import { ModelPicker } from "@/components/model-picker";
import { OwnerScopePicker } from "@/components/layout/owner-scope-picker";
import { canvasThemes } from "@/lib/canvas-theme";
import { requestEdit } from "@/services/api/image";
import { cancelImageGenerationTask, waitForImageGenerationTask } from "@/services/image-generation-tasks";
import { createProduct, deleteProduct, getProduct, setProductGenerationResult, updateProduct } from "@/services/products";
import { uploadImage } from "@/services/image-storage";
import { resolveModelChannel, useConfigStore, selectableModelsByCapability, useEffectiveConfig } from "@/stores/use-config-store";
import { useOwnerScopeStore } from "@/stores/use-owner-scope-store";
import { useProductStore } from "@/stores/use-product-store";
import { useThemeStore } from "@/stores/use-theme-store";
import type { Product, ProductMedia } from "@/types/product";
import type { ReferenceImage } from "@/types/image";

const MAX_SOURCE_IMAGES = 8;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

type DraftImage = Pick<ProductMedia, "mediaId" | "fileName" | "mimeType" | "bytes" | "url" | "thumbnailUrl" | "storageKey">;

function generationErrorMessage(error: unknown) {
    if (error instanceof Error && error.message.trim()) return error.message.trim();
    return typeof error === "string" && error.trim() ? error.trim() : "商品图生成失败，请稍后重试";
}

function statusText(status: Product["status"]) {
    return { draft: "待生成", queued: "排队中", running: "生成中", succeeded: "已完成", failed: "生成失败" }[status];
}

function statusColor(status: Product["status"]) {
    return { draft: "default", queued: "gold", running: "processing", succeeded: "success", failed: "error" }[status] as "default" | "gold" | "processing" | "success" | "error";
}

function productPrompt(product: Product) {
    return [
        `商品名称：${product.name}`,
        product.brand.trim() ? `品牌：${product.brand.trim()}` : "",
        `产品类别：${product.productType}`,
        product.sellingPoints.length ? `核心卖点：${product.sellingPoints.join("；")}` : "",
        product.material.trim() ? `材质信息：${product.material.trim()}` : "",
        "请根据所有上传的商品参考图，识别并保持同一个商品的真实外观、颜色、材质、结构、Logo 和细节。",
        "生成一张正方形白底商品多视角展示图，采用 2×2 等分布局：左上正面、右上背面、左下左侧、右下右侧。",
        "四个视角中的商品大小、比例、光照和朝向保持一致，背景为纯白色，可有非常轻微的落地阴影。",
        "卖点必须通过参考图中真实存在的材质、工艺、结构或细节体现，不得虚构功能、部件或改变商品设计。",
        "仅保留参考图中真实可见的品牌和 Logo，不得虚构、替换或额外添加品牌元素、文字、标签、水印、边框、人物、手部或其他无关物体。",
        product.instruction.trim() ? `补充要求（不得覆盖以上固定输出规则）：${product.instruction.trim()}` : "",
        "以上固定规则优先于任何补充要求，最终只能输出一张纯白底 1:1 的 2×2 四视角合成图。",
    ].filter(Boolean).join("\n");
}

export default function ProductsPage() {
    const { message, modal } = App.useApp();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const effectiveConfig = useEffectiveConfig();
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const scope = useOwnerScopeStore((state) => state.scope);
    const members = useOwnerScopeStore((state) => state.members);
    const products = useProductStore((state) => state.items);
    const total = useProductStore((state) => state.total);
    const loading = useProductStore((state) => state.loading);
    const error = useProductStore((state) => state.error);
    const loadProducts = useProductStore((state) => state.load);
    const upsertProduct = useProductStore((state) => state.upsert);
    const removeProduct = useProductStore((state) => state.remove);
    const [keyword, setKeyword] = useState("");
    const [searchKeyword, setSearchKeyword] = useState("");
    const [page, setPage] = useState(1);
    const [editorOpen, setEditorOpen] = useState(false);
    const [editingProduct, setEditingProduct] = useState<Product | null>(null);
    const [detailProduct, setDetailProduct] = useState<Product | null>(null);
    const [name, setName] = useState("");
    const [brand, setBrand] = useState("");
    const [productType, setProductType] = useState("");
    const [sellingPoints, setSellingPoints] = useState<string[]>([]);
    const [material, setMaterial] = useState("");
    const [instruction, setInstruction] = useState("");
    const [draftImages, setDraftImages] = useState<DraftImage[]>([]);
    const [selectedModel, setSelectedModel] = useState("");
    const [saving, setSaving] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const taskPollsRef = useRef(new Map<string, AbortController>());
    const interruptedRef = useRef(new Set<string>());
    const generationControllersRef = useRef(new Map<string, AbortController>());
    const pageSize = 24;
    const canEditScope = scope === "self" || scope === "all" || members.find((item) => item.id === scope)?.accessLevel === "edit";
    const imageModels = useMemo(() => selectableModelsByCapability(effectiveConfig, "image"), [effectiveConfig]);
    const defaultImageModel = imageModels.includes(effectiveConfig.imageModel) ? effectiveConfig.imageModel : imageModels[0] || "";

    useEffect(() => {
        const timer = window.setTimeout(() => {
            setPage(1);
            setSearchKeyword(keyword.trim());
        }, 300);
        return () => window.clearTimeout(timer);
    }, [keyword]);

    useEffect(() => {
        void loadProducts({ owner: scope, keyword: searchKeyword, page, pageSize });
    }, [loadProducts, page, pageSize, scope, searchKeyword]);

    useEffect(() => {
        if (!selectedModel && defaultImageModel) setSelectedModel(defaultImageModel);
    }, [defaultImageModel, selectedModel]);

    useEffect(() => {
        if (!detailProduct) return;
        const latest = products.find((product) => product.id === detailProduct.id);
        if (latest && latest.updatedAt !== detailProduct.updatedAt) setDetailProduct(latest);
    }, [detailProduct, products]);

    useEffect(() => {
        products.filter((product) => product.activeTaskId && (product.status === "queued" || product.status === "running")).forEach((product) => {
            if (taskPollsRef.current.has(product.id)) return;
            const controller = new AbortController();
            taskPollsRef.current.set(product.id, controller);
            void waitForImageGenerationTask(product.activeTaskId!, {
                signal: controller.signal,
                onUpdate: (task) => {
                    const current = useProductStore.getState().items.find((item) => item.id === product.id);
                    if (!current) return;
                    const nextStatus: Product["status"] = task.status === "queued" ? "queued" : task.status === "running" ? "running" : task.status === "succeeded" ? "succeeded" : "failed";
                    upsertProduct({ ...current, status: nextStatus, activeTaskId: task.status === "queued" || task.status === "running" ? task.id : undefined, error: task.error });
                },
            }).then(async () => {
                const refreshed = await getProduct(product.id);
                upsertProduct(refreshed);
            }).catch(() => undefined).finally(() => {
                taskPollsRef.current.delete(product.id);
            });
        });

        products.filter((product) => product.status === "running" && !product.activeTaskId && !generationControllersRef.current.has(product.id) && !interruptedRef.current.has(product.id)).forEach((product) => {
            interruptedRef.current.add(product.id);
            void setProductGenerationResult(product.id, { status: "failed", error: "页面刷新后浏览器直连生成已中断，请重新生成" }).then(upsertProduct).catch(() => undefined);
        });
    }, [products, upsertProduct]);

    useEffect(() => () => {
        taskPollsRef.current.forEach((controller) => controller.abort());
        generationControllersRef.current.forEach((controller) => controller.abort());
    }, []);

    const openCreate = () => {
        setEditingProduct(null);
        setName("");
        setBrand("");
        setProductType("");
        setSellingPoints([]);
        setMaterial("");
        setInstruction("");
        setDraftImages([]);
        setSelectedModel(defaultImageModel);
        setEditorOpen(true);
    };

    const openEdit = (product: Product) => {
        setEditingProduct(product);
        setName(product.name);
        setBrand(product.brand);
        setProductType(product.productType);
        setSellingPoints(product.sellingPoints);
        setMaterial(product.material);
        setInstruction(product.instruction);
        setDraftImages(product.sourceImages.map((image) => ({ ...image })));
        setSelectedModel(defaultImageModel);
        setEditorOpen(true);
    };

    const addFiles = async (files: FileList | File[] | null) => {
        const available = MAX_SOURCE_IMAGES - draftImages.length;
        const selected = Array.from(files || []).filter((file) => file.type.startsWith("image/")).slice(0, available);
        if (!selected.length) {
            if (available <= 0) message.warning(`每个商品最多上传 ${MAX_SOURCE_IMAGES} 张参考图`);
            else message.warning("请选择图片文件");
            return;
        }
        if (Array.from(files || []).some((file) => file.size > MAX_IMAGE_BYTES)) {
            message.warning("单张商品参考图不能超过 20MB");
        }
        try {
            const uploaded = await Promise.all(selected.filter((file) => file.size <= MAX_IMAGE_BYTES).map(async (file) => {
                const image = await uploadImage(file, useOwnerScopeStore.getState().scope === "self" || useOwnerScopeStore.getState().scope === "all" ? undefined : useOwnerScopeStore.getState().scope);
                return { mediaId: image.storageKey.slice("media:".length), fileName: file.name, mimeType: image.mimeType, bytes: image.bytes, url: image.url, thumbnailUrl: image.thumbnailUrl, storageKey: image.storageKey };
            }));
            setDraftImages((current) => [...current, ...uploaded].slice(0, MAX_SOURCE_IMAGES));
        } catch (uploadError) {
            message.error(generationErrorMessage(uploadError));
        }
    };

    const saveEditor = async (generateAfter = false) => {
        if (!name.trim()) return message.warning("请输入商品名称");
        if (!productType.trim()) return message.warning("请输入产品");
        if (!draftImages.length) return message.warning("请至少上传 1 张商品参考图");
        setSaving(true);
        try {
            const result = editingProduct
                ? await updateProduct(editingProduct.id, { revision: editingProduct.revision, name: name.trim(), brand: brand.trim(), productType: productType.trim(), sellingPoints, material: material.trim(), instruction: instruction.trim(), sourceMediaIds: draftImages.map((image) => image.mediaId) })
                : await createProduct({ name: name.trim(), brand: brand.trim(), productType: productType.trim(), sellingPoints, material: material.trim(), instruction: instruction.trim(), sourceMediaIds: draftImages.map((image) => image.mediaId) });
            upsertProduct(result);
            setEditorOpen(false);
            message.success(editingProduct ? "商品已保存" : "商品已创建");
            if (generateAfter) void generateProduct(result, selectedModel);
        } catch (saveError) {
            message.error(generationErrorMessage(saveError));
        } finally {
            setSaving(false);
        }
    };

    const generateProduct = async (product: Product, model = selectedModel || defaultImageModel) => {
        if (product.accessLevel === "view") return message.warning("你只有查看权限");
        if (generationControllersRef.current.has(product.id) || product.activeTaskId || product.status === "queued") return message.info("该商品已有生成任务，请等待当前任务结束");
        if (!model || !isAiConfigReady(effectiveConfig, model)) {
            openConfigDialog(true, "channels");
            return message.warning("请先配置可用的图片模型");
        }
        const controller = new AbortController();
        generationControllersRef.current.set(product.id, controller);
        const config = { ...effectiveConfig, model, imageModel: model, count: "1", size: "1:1", background: "" };
        const isRemote = resolveModelChannel(effectiveConfig, model).source === "remote";
        const references: ReferenceImage[] = product.sourceImages.map((image) => ({ id: image.mediaId, name: image.fileName, type: image.mimeType, dataUrl: image.url, url: image.url, storageKey: image.storageKey }));
        try {
            if (!isRemote) upsertProduct(await setProductGenerationResult(product.id, { status: "running" }));
            const [result] = await requestEdit(config, productPrompt(product), references, undefined, {
                ownerId: product.ownerId,
                clientRequestId: `product-${nanoid()}`,
                context: { origin: "product", productId: product.id },
                signal: controller.signal,
                onTaskUpdate: (task) => {
                    const current = useProductStore.getState().items.find((item) => item.id === product.id);
                    if (!current) return;
                    upsertProduct({ ...current, status: task.status === "queued" ? "queued" : task.status === "running" ? "running" : task.status === "succeeded" ? "succeeded" : "failed", activeTaskId: task.status === "queued" || task.status === "running" ? task.id : undefined, error: task.error });
                },
            });
            if (!result) throw new Error("模型没有返回商品图");
            if (!isRemote) {
                const stored = await uploadImage(result.dataUrl, product.ownerId);
                upsertProduct(await setProductGenerationResult(product.id, { status: "succeeded", mediaId: stored.storageKey.slice("media:".length) }));
            } else {
                upsertProduct(await getProduct(product.id));
            }
            message.success("商品图生成完成");
        } catch (generationError) {
            if (controller.signal.aborted) return;
            const errorText = generationErrorMessage(generationError);
            if (!isRemote) {
                try { upsertProduct(await setProductGenerationResult(product.id, { status: "failed", error: errorText })); } catch { /* 保留原状态，等待下次刷新 */ }
            } else {
                try { upsertProduct(await getProduct(product.id)); } catch { /* Worker 会继续写回任务结果 */ }
            }
            message.error(errorText);
        } finally {
            generationControllersRef.current.delete(product.id);
        }
    };

    const cancelProduct = async (product: Product) => {
        if (!product.activeTaskId) return;
        try {
            await cancelImageGenerationTask(product.activeTaskId);
            upsertProduct(await getProduct(product.id));
        } catch (cancelError) {
            message.error(generationErrorMessage(cancelError));
        }
    };

    const confirmDelete = (product: Product) => {
        modal.confirm({
            title: `删除「${product.name}」？`,
            content: "只会删除商品记录，不会删除可能被其他画布或资产引用的媒体文件。",
            okText: "删除",
            okButtonProps: { danger: true },
            cancelText: "取消",
            onOk: async () => {
                try {
                    await deleteProduct(product.id);
                    removeProduct(product.id);
                    if (detailProduct?.id === product.id) setDetailProduct(null);
                    message.success("商品已删除");
                } catch (deleteError) {
                    message.error(generationErrorMessage(deleteError));
                }
            },
        });
    };

    const downloadResult = async (product: Product) => {
        if (!product.resultImage) return;
        try {
            saveAs(await (await fetch(product.resultImage.url)).blob(), `${product.name}-四视角.png`);
        } catch {
            message.error("下载商品图失败");
        }
    };

    return (
        <div className="h-full overflow-y-auto bg-background text-foreground">
            <div className="mx-auto max-w-[1600px] px-6 py-8">
                <div className="flex flex-wrap items-end justify-between gap-4">
                    <div>
                        <h1 className="text-3xl font-semibold tracking-tight">商品图</h1>
                        <p className="mt-2 text-sm text-muted-foreground">上传商品参考图，生成白底四视角展示图。</p>
                    </div>
                    <OwnerScopePicker />
                </div>
                <div className="mt-7 flex flex-wrap items-center justify-between gap-3">
                    <Input value={keyword} onChange={(event) => setKeyword(event.target.value)} allowClear prefix={<Search className="size-4 text-muted-foreground" />} placeholder="搜索商品名称" className="w-full max-w-sm" />
                    <Button type="primary" icon={<Plus className="size-4" />} disabled={!canEditScope} onClick={openCreate}>新增商品</Button>
                </div>
                {error ? <div className="mt-5 rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm text-red-600">{error}</div> : null}
                {loading && !products.length ? <div className="flex min-h-64 items-center justify-center"><Spin /></div> : null}
                {!loading && !products.length ? <Empty className="py-24" image={<PackageOpen className="mx-auto size-12 text-muted-foreground" />} description={searchKeyword ? "没有找到匹配的商品" : "还没有商品，先上传一组商品图"} /> : null}
                {products.length ? (
                    <>
                        <div className="mt-6 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
                            {products.map((product) => <ProductCard key={product.id} product={product} onOpen={() => setDetailProduct(product)} onEdit={() => openEdit(product)} onGenerate={() => void generateProduct(product)} onCancel={() => void cancelProduct(product)} onDelete={() => confirmDelete(product)} onDownload={() => void downloadResult(product)} />)}
                        </div>
                        {total > pageSize ? (
                            <div className="mt-8 flex items-center justify-center gap-3">
                                <Button disabled={page <= 1} icon={<ChevronLeft className="size-4" />} onClick={() => setPage((value) => value - 1)}>上一页</Button>
                                <span className="text-sm text-muted-foreground">{page} / {Math.ceil(total / pageSize)}</span>
                                <Button disabled={page >= Math.ceil(total / pageSize)} icon={<ChevronRight className="size-4" />} onClick={() => setPage((value) => value + 1)}>下一页</Button>
                            </div>
                        ) : null}
                    </>
                ) : null}
            </div>

            <Modal
                open={editorOpen}
                width={760}
                title={editingProduct ? "编辑商品" : "新增商品"}
                onCancel={() => setEditorOpen(false)}
                destroyOnHidden
                footer={[
                    <Button key="cancel" onClick={() => setEditorOpen(false)}>取消</Button>,
                    <Button key="save" loading={saving} onClick={() => void saveEditor(false)}>保存</Button>,
                    <Button key="generate" type="primary" loading={saving} onClick={() => void saveEditor(true)}>保存并生成</Button>,
                ]}
            >
                <div className="space-y-5">
                    <div>
                        <div className="mb-2 text-sm font-medium">商品名称</div>
                        <Input value={name} maxLength={100} showCount onChange={(event) => setName(event.target.value)} placeholder="例如：黑色皮质通勤包" />
                    </div>
                    <div className="grid gap-5 sm:grid-cols-2">
                        <div>
                            <div className="mb-2 text-sm font-medium">品牌（可选）</div>
                            <Input value={brand} maxLength={100} showCount onChange={(event) => setBrand(event.target.value)} placeholder="例如：Nike" />
                        </div>
                        <div>
                            <div className="mb-2 text-sm font-medium">产品</div>
                            <Input value={productType} maxLength={100} showCount onChange={(event) => setProductType(event.target.value)} placeholder="例如：鞋子" />
                        </div>
                    </div>
                    <div>
                        <div className="mb-2 text-sm font-medium">卖点（可选）</div>
                        <Select mode="tags" value={sellingPoints} maxCount={50} tokenSeparators={[",", "，"]} placeholder="输入卖点后按回车，例如：针缝刺绣" className="w-full" onChange={setSellingPoints} />
                        <div className="mt-1.5 text-xs text-muted-foreground">最多 50 个，每个不超过 80 个字符。</div>
                    </div>
                    <div>
                        <div className="mb-2 text-sm font-medium">材质信息（可选）</div>
                        <Input.TextArea value={material} maxLength={500} showCount rows={2} onChange={(event) => setMaterial(event.target.value)} placeholder="例如：鞋面为头层牛皮，鞋底为耐磨橡胶" />
                    </div>
                    <div>
                        <div className="mb-2 text-sm font-medium">补充要求（可选）</div>
                        <Input.TextArea value={instruction} maxLength={2_000} showCount rows={3} onChange={(event) => setInstruction(event.target.value)} placeholder="例如：突出金属扣件和皮革纹理，不改变商品结构" />
                    </div>
                    <div>
                        <div className="mb-2 flex items-center justify-between text-sm font-medium">
                            <span>商品参考图（{draftImages.length}/{MAX_SOURCE_IMAGES}）</span>
                            <Button type="text" size="small" icon={<Upload className="size-4" />} disabled={draftImages.length >= MAX_SOURCE_IMAGES} onClick={() => fileInputRef.current?.click()}>上传图片</Button>
                        </div>
                        <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden" onChange={(event) => { void addFiles(event.target.files); event.target.value = ""; }} />
                        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                            {draftImages.map((image, index) => (
                                <div key={image.mediaId} className="group relative aspect-square overflow-hidden rounded-xl border border-border bg-muted">
                                    <img src={image.thumbnailUrl || image.url} alt={image.fileName} className="size-full object-contain" />
                                    <button type="button" className="absolute right-1 top-1 grid size-7 place-items-center rounded-full bg-black/55 text-white opacity-0 transition group-hover:opacity-100" onClick={() => setDraftImages((current) => current.filter((item) => item.mediaId !== image.mediaId))} aria-label={`移除第 ${index + 1} 张图片`}><X className="size-4" /></button>
                                    <div className="absolute inset-x-1 bottom-1 flex justify-between opacity-0 transition group-hover:opacity-100">
                                        <button type="button" className="grid size-7 place-items-center rounded-full bg-black/55 text-white disabled:opacity-30" disabled={index === 0} onClick={() => setDraftImages((current) => moveItem(current, index, -1))} aria-label="向前移动"><ChevronLeft className="size-4" /></button>
                                        <button type="button" className="grid size-7 place-items-center rounded-full bg-black/55 text-white disabled:opacity-30" disabled={index === draftImages.length - 1} onClick={() => setDraftImages((current) => moveItem(current, index, 1))} aria-label="向后移动"><ChevronRight className="size-4" /></button>
                                    </div>
                                </div>
                            ))}
                            {draftImages.length < MAX_SOURCE_IMAGES ? <button type="button" className="flex aspect-square flex-col items-center justify-center rounded-xl border border-dashed border-border text-sm text-muted-foreground transition hover:border-primary hover:text-primary" onClick={() => fileInputRef.current?.click()}><ImagePlus className="mb-2 size-6" />添加图片</button> : null}
                        </div>
                    </div>
                    <div>
                        <div className="mb-2 text-sm font-medium">图片模型</div>
                        <ModelPicker config={effectiveConfig} value={selectedModel} capability="image" fullWidth onChange={setSelectedModel} onMissingConfig={() => openConfigDialog(true, "channels")} />
                    </div>
                </div>
            </Modal>

            <Modal open={Boolean(detailProduct)} width={980} title={detailProduct?.name} onCancel={() => setDetailProduct(null)} footer={null}>
                {detailProduct ? <ProductDetail product={detailProduct} theme={theme} onGenerate={() => { setDetailProduct(null); void generateProduct(detailProduct); }} onCancel={() => void cancelProduct(detailProduct)} onEdit={() => { setDetailProduct(null); openEdit(detailProduct); }} onDownload={() => void downloadResult(detailProduct)} /> : null}
            </Modal>
        </div>
    );
}

function ProductCard({ product, onOpen, onEdit, onGenerate, onCancel, onDelete, onDownload }: { product: Product; onOpen: () => void; onEdit: () => void; onGenerate: () => void; onCancel: () => void; onDelete: () => void; onDownload: () => void }) {
    return (
        <div className="group overflow-hidden rounded-2xl border border-border bg-card transition hover:border-primary/40 hover:shadow-lg">
            <button type="button" className="block w-full text-left" onClick={onOpen}>
                <div className="relative aspect-square overflow-hidden bg-muted">
                    {product.resultImage ? <img src={product.resultImage.thumbnailUrl || product.resultImage.url} alt={product.name} className="size-full object-contain transition duration-300 group-hover:scale-[1.02]" /> : <div className="flex size-full flex-col items-center justify-center gap-3 text-muted-foreground">{product.status === "queued" || product.status === "running" ? <LoaderCircle className="size-8 animate-spin" /> : <PackageOpen className="size-10 opacity-50" />}<span className="text-sm">{product.status === "queued" || product.status === "running" ? "商品图生成中" : "尚未生成合成图"}</span></div>}
                    <Tag color={statusColor(product.status)} className="absolute left-3 top-3">{statusText(product.status)}</Tag>
                </div>
                <div className="px-4 pb-3 pt-4">
                    <div className="truncate font-medium">{product.name}</div>
                    {product.brand || product.productType ? <div className="mt-1 truncate text-xs text-muted-foreground">{[product.brand, product.productType].filter(Boolean).join(" · ")}</div> : null}
                    {product.sellingPoints.length ? <div className="mt-2 flex flex-wrap gap-1">{product.sellingPoints.map((item) => <Tag key={item} className="m-0 max-w-full truncate text-[11px]">{item}</Tag>)}</div> : null}
                    <div className="mt-1 text-xs text-muted-foreground">{product.sourceImages.length} 张参考图 · {product.ownerUsername}</div>
                    {product.error ? <div className="mt-2 line-clamp-2 text-xs text-red-600">{product.error}</div> : null}
                </div>
            </button>
            <div className="flex items-center gap-1 border-t border-border px-3 py-2">
                <Button type="text" size="small" icon={<Edit3 className="size-3.5" />} disabled={product.accessLevel === "view"} onClick={onEdit}>编辑</Button>
                {product.activeTaskId ? <Button type="text" size="small" danger onClick={onCancel}>取消</Button> : <Button type="text" size="small" icon={<RefreshCw className="size-3.5" />} disabled={product.accessLevel === "view" || product.status === "queued" || product.status === "running"} onClick={onGenerate}>{product.resultImage ? "重新生成" : "生成"}</Button>}
                {product.resultImage ? <Button type="text" size="small" icon={<Download className="size-3.5" />} onClick={onDownload}>下载</Button> : null}
                <Button type="text" size="small" danger icon={<Trash2 className="size-3.5" />} disabled={product.accessLevel === "view"} onClick={onDelete} aria-label="删除商品" />
            </div>
        </div>
    );
}

function ProductDetail({ product, theme, onGenerate, onCancel, onEdit, onDownload }: { product: Product; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; onGenerate: () => void; onCancel: () => void; onEdit: () => void; onDownload: () => void }) {
    return (
        <div className="space-y-6">
            <div className="grid gap-6 md:grid-cols-[1.2fr_1fr]">
                <div>
                    <div className="mb-3 text-sm font-medium">四视角合成图</div>
                    {product.resultImage ? <Image src={product.resultImage.url} className="!block overflow-hidden rounded-xl border border-border bg-muted [&_img]:!w-full [&_img]:!object-contain" /> : <div className="flex aspect-square items-center justify-center rounded-xl border border-dashed border-border bg-muted text-sm text-muted-foreground">{product.status === "queued" || product.status === "running" ? "商品图生成中…" : "暂无合成图"}</div>}
                </div>
                <div className="space-y-4">
                    <div className="rounded-xl border border-border p-4">
                        <div className="flex items-center justify-between"><span className="text-sm text-muted-foreground">状态</span><Tag color={statusColor(product.status)}>{statusText(product.status)}</Tag></div>
                        <div className="mt-3 text-sm text-muted-foreground">参考图 {product.sourceImages.length} 张</div>
                        {product.brand || product.productType ? <div className="mt-3 text-sm"><span className="text-muted-foreground">品牌 / 产品：</span>{[product.brand, product.productType].filter(Boolean).join(" · ")}</div> : null}
                        {product.sellingPoints.length ? <div className="mt-3"><div className="mb-1.5 text-sm text-muted-foreground">卖点</div><div className="flex flex-wrap gap-1">{product.sellingPoints.map((item) => <Tag key={item} className="m-0">{item}</Tag>)}</div></div> : null}
                        {product.material ? <div className="mt-3 text-sm"><span className="text-muted-foreground">材质：</span>{product.material}</div> : null}
                        {product.error ? <div className="mt-3 rounded-lg bg-red-500/5 px-3 py-2 text-sm text-red-600">{product.error}</div> : null}
                    </div>
                    <div className="flex flex-wrap gap-2">
                        {product.activeTaskId ? <Button danger onClick={onCancel}>取消排队任务</Button> : <Button type="primary" icon={<RefreshCw className="size-4" />} disabled={product.accessLevel === "view" || product.status === "queued" || product.status === "running"} onClick={onGenerate}>{product.resultImage ? "重新生成" : "生成商品图"}</Button>}
                        <Button icon={<Edit3 className="size-4" />} disabled={product.accessLevel === "view"} onClick={onEdit}>编辑</Button>
                        <Button icon={<Download className="size-4" />} disabled={!product.resultImage} onClick={onDownload}>下载合成图</Button>
                    </div>
                </div>
            </div>
            <div>
                <div className="mb-3 text-sm font-medium">原始参考图</div>
                <Image.PreviewGroup>
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                        {product.sourceImages.map((image) => <Image key={image.id} src={image.url} preview={{ mask: "查看原图" }} className="!block aspect-square overflow-hidden rounded-xl border border-border bg-muted [&_img]:!h-full [&_img]:!w-full [&_img]:!object-contain" />)}
                    </div>
                </Image.PreviewGroup>
            </div>
            <div className="text-xs leading-5" style={{ color: theme.node.muted }}>
                {product.instruction ? `补充要求：${product.instruction}` : "系统会固定生成纯白底 2×2 四视角展示图。"}
            </div>
        </div>
    );
}

function moveItem<T>(items: T[], index: number, offset: number) {
    const next = [...items];
    const target = index + offset;
    if (target < 0 || target >= next.length) return next;
    [next[index], next[target]] = [next[target], next[index]];
    return next;
}

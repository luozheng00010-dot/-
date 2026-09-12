import { ArrowLeft, ChevronLeft, ChevronRight, Download, FileImage, ImagePlus, LoaderCircle, PackageOpen, Pencil, Plus, RefreshCw, Search, Sparkles, Trash2, Upload, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { App, Button, Empty, Image, Input, Modal, Pagination, Popover, Select, Spin, Tag, Tooltip } from "antd";
import { saveAs } from "file-saver";

import { ModelPicker } from "@/components/model-picker";
import { DetailPageTemplateEditor } from "@/components/detail-page-template-editor";
import { OwnerScopePicker } from "@/components/layout/owner-scope-picker";
import { ProductSelect } from "@/components/product-select";
import { requestEdit } from "@/services/api/image";
import { listDetailPageTemplates } from "@/services/detail-page-templates";
import {
    addDetailPagePairReference,
    cancelDetailPagePair,
    cancelDetailPagePairVariant,
    createDetailPagePairVariant,
    createDetailPageProject,
    deleteDetailPagePairReference,
    deleteDetailPagePairVariant,
    deleteDetailPageProject,
    generateDetailPagePair,
    generateDetailPageProject,
    getDetailPageProject,
    listDetailPageProjects,
    promoteDetailPagePairVariant,
    setDetailPagePairResult,
    setDetailPagePairVariantResult,
    updateDetailPagePairPrompt,
    updateDetailPageProject,
} from "@/services/detail-pages";
import { CanvasNodeMaskEditDialog, type CanvasImageMaskEditPayload } from "@/components/canvas/canvas-node-mask-edit-dialog";
import { CanvasPromptChipInput } from "@/components/canvas/canvas-prompt-chip-input";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { imageToDataUrl, uploadImage } from "@/services/image-storage";
import { getProduct, listAllProducts, listProducts } from "@/services/products";
import { modelOptionName, resolveModelChannel, selectableModelsByCapability, useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { currentAccessLevel, useOwnerScopeStore } from "@/stores/use-owner-scope-store";
import type { ReferenceImage } from "@/types/image";
import type { Product } from "@/types/product";
import type { DetailPageMedia, DetailPagePair, DetailPagePairVariant, DetailPageProject, DetailPageProjectStatus, DetailPageTemplate } from "@/types/detail-page";

const MAX_REFERENCES = 18;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const PROJECT_PAGE_SIZE = 12;
const PROMPT_RESOLUTIONS = ["1k", "2k", "4k"] as const;
const PROMPT_ASPECTS = ["original", "1:1", "3:2", "2:3", "16:9", "9:16", "4:3", "3:4", "21:9"] as const;
const PROMPT_QUALITIES = ["auto", "low", "medium", "high"] as const;
const PROMPT_ASPECT_LABELS: Record<string, string> = {
    original: "维持原参考图比例",
    "1:1": "方形 1:1",
    "3:2": "横向 3:2",
    "2:3": "竖向 2:3",
    "16:9": "横向 16:9",
    "9:16": "竖向 9:16",
    "4:3": "横向 4:3",
    "3:4": "竖向 3:4",
    "21:9": "横向 21:9",
};

type DraftReference = DetailPageMedia;

function messageText(error: unknown) {
    return error instanceof Error && error.message.trim() ? error.message.trim() : typeof error === "string" && error.trim() ? error.trim() : "请求失败，请稍后重试";
}

function projectStatusText(status: DetailPageProjectStatus) {
    return { draft: "待生成", generating: "生成中", partial: "部分完成", succeeded: "已完成", failed: "生成失败" }[status] || "待处理";
}

function pairStatusText(status: DetailPagePair["status"]) {
    return { draft: "待生成", queued: "排队中", running: "生成中", succeeded: "已完成", failed: "生成失败", interrupted: "已中断" }[status];
}

function pairTagColor(status: DetailPagePair["status"]) {
    if (status === "succeeded") return "success";
    if (status === "queued") return "gold";
    if (status === "running") return "processing";
    if (status === "failed" || status === "interrupted") return "error";
    return "default";
}

function projectTagColor(status: DetailPageProjectStatus) {
    if (status === "succeeded") return "success";
    if (status === "generating") return "processing";
    if (status === "partial") return "warning";
    if (status === "failed") return "error";
    return "default";
}

function productPrompt(product: Product | DetailPageProject["product"]) {
    return [
        "图一是我们的产品图，图二是我们要复刻的详情页参考图片。",
        "以图一中的商品为唯一主体，保持商品的真实外形、颜色、结构、材质、细节和品牌标识。",
        "保持参考图的文字排版、信息层级、构图、字体风格、色彩、光线、背景、装饰和整体视觉风格，但不要复制参考图中的竞品商品。",
        "根据用户商品资料和参考图当前表达的主题，选择最匹配的真实卖点生成新的标题、卖点文字。文字必须描述用户商品，不得虚构商品没有提供的功能、材质、成分或数据。",
        "不要复制参考图中的竞品品牌、Logo、商标、价格、原文案或水印；如果参考图中有人物，保持人物的姿态、动作、肢体表现、服装展示关系和画面构图，但不要复制原人物的身份。如果参考图中只出现人物的部分肢体，保留这些可见的人物部分肢体、姿态和构图，不补全未出现的身体部分。将人物脸替换为气质、年龄和风格相近且明确不同的全新面孔，不要复刻或还原任何具体个人；用户商品自身品牌必须保留。",
        "品牌：{{product.brand}}",
        "材质：{{product.material}}",
        "可用卖点：{{product.sellingPoints}}",
    ].join("\n");
}

function referenceRatio(pair: Pick<DetailPagePair, "referenceWidth" | "referenceHeight">) {
    return pair.referenceWidth > 0 && pair.referenceHeight > 0 ? `${pair.referenceWidth} / ${pair.referenceHeight}` : "2 / 3";
}

function pairGenerationSize(pair: DetailPagePair) {
    return promptPixelSize(pair, pair.generationResolution || "1k", pair.generationAspectRatio || "original").replace(/\s/g, "");
}

function promptPixelSize(pair: DetailPagePair, resolution: string, aspect: string) {
    const base = resolution === "4k" ? 2880 : resolution === "2k" ? 2048 : 1024;
    const ratioText = aspect === "original" ? `${pair.referenceWidth || 2}:${pair.referenceHeight || 3}` : aspect;
    const [rw, rh] = ratioText.split(":").map(Number);
    const ratio = Math.max(1 / 3, Math.min(3, rw / Math.max(1, rh)));
    const landscape = ratio >= 1;
    const longRatio = landscape ? ratio : 1 / ratio;
    let longSide = Math.floor(Math.sqrt(base * base * longRatio) / 16) * 16;
    if (longSide > 3840) longSide = 3840;
    const shortSide = Math.max(16, Math.round(longSide / longRatio / 16) * 16);
    return landscape ? `${longSide} x ${shortSide}` : `${shortSide} x ${longSide}`;
}

function mediaSrc(media?: DetailPageMedia) {
    return media?.thumbnailUrl || media?.url || "";
}

function moveItem<T>(items: T[], index: number, offset: number) {
    const target = index + offset;
    if (target < 0 || target >= items.length) return items;
    const next = [...items];
    [next[index], next[target]] = [next[target], next[index]];
    return next;
}

function ProductSummary({ product, large = false }: { product: Product | DetailPageProject["product"]; large?: boolean }) {
    const src = product.resultImage?.thumbnailUrl || product.resultImage?.url;
    return (
        <div className={`flex min-w-0 items-center ${large ? "gap-3" : "gap-2"}`}>
            <div className={`grid shrink-0 place-items-center overflow-hidden rounded-lg border border-border bg-muted ${large ? "size-16" : "size-10"}`}>
                {src ? <img src={src} alt="" className="size-full object-contain" /> : <PackageOpen className="size-5 text-muted-foreground" />}
            </div>
            <div className="min-w-0">
                <div className={`truncate font-medium ${large ? "text-base" : "text-sm"}`}>{product.name}</div>
                {[product.brand, product.productType].filter(Boolean).length ? <div className="truncate text-xs text-muted-foreground">{[product.brand, product.productType].filter(Boolean).join(" · ")}</div> : null}
            </div>
        </div>
    );
}

function TemplateThumbnail({ template, compact = false }: { template: DetailPageTemplate; compact?: boolean }) {
    const src = template.coverImage?.thumbnailUrl || template.coverImage?.url;
    const [failed, setFailed] = useState(false);
    useEffect(() => setFailed(false), [src]);
    return (
        <span className={`grid shrink-0 place-items-center overflow-hidden rounded-lg border border-border bg-muted ${compact ? "size-8" : "size-12"}`}>
            {src && !failed ? <img src={src} alt="" loading="lazy" decoding="async" className="size-full object-contain" onError={() => setFailed(true)} /> : <FileImage className={`${compact ? "size-4" : "size-5"} text-muted-foreground`} />}
        </span>
    );
}

function TemplateOption({ template, compact = false }: { template: DetailPageTemplate; compact?: boolean }) {
    return (
        <span className={`flex min-w-0 items-center ${compact ? "h-9 gap-2" : "min-h-14 gap-3 py-1"}`}>
            <TemplateThumbnail template={template} compact={compact} />
            <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-foreground">{template.name}</span>
                {!compact ? <span className="mt-0.5 block truncate text-xs text-muted-foreground">{template.referenceCount} 张参考图</span> : null}
            </span>
        </span>
    );
}

function TemplateSelect({ templates, value, loading, disabled, onChange }: { templates: DetailPageTemplate[]; value: string; loading: boolean; disabled: boolean; onChange: (value: string) => void }) {
    const templateById = useMemo(() => new Map(templates.map((template) => [template.id, template])), [templates]);
    const options = useMemo(() => templates.map((template) => ({ value: template.id, label: template.name })), [templates]);
    return (
        <Select<string>
            className="w-full"
            size="large"
            value={value || undefined}
            loading={loading}
            disabled={disabled || loading}
            allowClear
            showSearch
            virtual={false}
            optionFilterProp="label"
            placeholder={disabled ? "请先选择商品" : "选择详情页模板（可选）"}
            notFoundContent={
                loading ? (
                    <div className="py-4 text-center">
                        <Spin size="small" />
                    </div>
                ) : (
                    "暂无可用模板"
                )
            }
            options={options}
            onChange={(next) => onChange(next || "")}
            optionRender={(option) => {
                const template = templateById.get(String(option.value));
                return template ? <TemplateOption template={template} /> : option.label;
            }}
            labelRender={(label) => {
                const template = templateById.get(String(label.value));
                return template ? <TemplateOption template={template} compact /> : label.label;
            }}
        />
    );
}

function ReferencePreview({ media, label, ratio }: { media?: DetailPageMedia; label: string; ratio: string }) {
    const src = media?.thumbnailUrl || media?.url || mediaSrc(media);
    return (
        <div className="relative overflow-hidden rounded-xl border border-border bg-muted" style={{ aspectRatio: ratio }}>
            {src ? (
                <Image
                    rootClassName="!block !h-full !w-full"
                    src={src}
                    alt={label}
                    preview={{ src: media?.url || src, mask: "查看原图" }}
                    className="!block !h-full !w-full [&_.ant-image-img]:!h-full [&_.ant-image-img]:!w-full [&_.ant-image-img]:!object-contain"
                />
            ) : (
                <div className="grid size-full place-items-center text-xs text-muted-foreground">图片不可用</div>
            )}
        </div>
    );
}

export default function DetailPagesPage() {
    const { message, modal } = App.useApp();
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const scope = useOwnerScopeStore((state) => state.scope);
    const effectiveConfig = useEffectiveConfig();
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const [projects, setProjects] = useState<DetailPageProject[]>([]);
    const [projectTotal, setProjectTotal] = useState(0);
    const [projectPage, setProjectPage] = useState(1);
    const [keyword, setKeyword] = useState("");
    const [searchKeyword, setSearchKeyword] = useState("");
    const [project, setProject] = useState<DetailPageProject | null>(null);
    const [loading, setLoading] = useState(false);
    const [workspaceLoading, setWorkspaceLoading] = useState(false);
    const [createOpen, setCreateOpen] = useState(false);
    const [title, setTitle] = useState("");
    const [products, setProducts] = useState<Product[]>([]);
    const [selectedProductId, setSelectedProductId] = useState("");
    const selectedProductIdRef = useRef("");
    const [draftReferences, setDraftReferences] = useState<DraftReference[]>([]);
    const [templates, setTemplates] = useState<DetailPageTemplate[]>([]);
    const [templateLoading, setTemplateLoading] = useState(false);
    const [selectedTemplateId, setSelectedTemplateId] = useState("");
    const selectedTemplateIdRef = useRef("");
    const [templateEditorOpen, setTemplateEditorOpen] = useState(false);
    const [productLoading, setProductLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [selectedModel, setSelectedModel] = useState("");
    const [promptPair, setPromptPair] = useState<DetailPagePair | null>(null);
    const [promptValue, setPromptValue] = useState("");
    const [promptSaving, setPromptSaving] = useState(false);
    const [promptModel, setPromptModel] = useState("");
    const [promptResolution, setPromptResolution] = useState<string>("1k");
    const [promptAspect, setPromptAspect] = useState<string>("original");
    const [promptQuality, setPromptQuality] = useState<string>("auto");
    const [promptReferenceInput, setPromptReferenceInput] = useState<HTMLInputElement | null>(null);
    const [personalRunning, setPersonalRunning] = useState<Set<string>>(new Set());
    const [selectedVariantIds, setSelectedVariantIds] = useState<Record<string, string>>({});
    const [maskEditPair, setMaskEditPair] = useState<DetailPagePair | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const pollRef = useRef<number | null>(null);
    const runningRef = useRef(new Set<string>());
    const imageModels = useMemo(() => selectableModelsByCapability(effectiveConfig, "image"), [effectiveConfig]);
    const defaultImageModel = imageModels.includes(effectiveConfig.imageModel) ? effectiveConfig.imageModel : imageModels[0] || "";
    const selectedProduct = products.find((item) => item.id === selectedProductId);
    const scopeCanEdit = currentAccessLevel() === "edit";
    const canvasId = searchParams.get("canvasId");
    const canvasNodeId = searchParams.get("nodeId");
    const initialProjectId = searchParams.get("projectId");
    const requestedProductId = searchParams.get("productId") || "";

    useEffect(() => {
        const timer = window.setTimeout(() => {
            setProjectPage(1);
            setSearchKeyword(keyword.trim());
        }, 300);
        return () => window.clearTimeout(timer);
    }, [keyword]);

    useEffect(() => {
        if (initialProjectId) return;
        let disposed = false;
        setLoading(true);
        void listDetailPageProjects({ owner: scope, keyword: searchKeyword, page: projectPage, pageSize: PROJECT_PAGE_SIZE })
            .then((result) => {
                if (disposed) return;
                setProjects(result.items);
                setProjectTotal(result.total);
            })
            .catch((error) => !disposed && message.error(messageText(error)))
            .finally(() => !disposed && setLoading(false));
        return () => {
            disposed = true;
        };
    }, [initialProjectId, message, projectPage, scope, searchKeyword]);

    useEffect(() => {
        if (!initialProjectId) return;
        let disposed = false;
        setWorkspaceLoading(true);
        void getDetailPageProject(initialProjectId)
            .then((result) => {
                if (!disposed) setProject(result);
            })
            .catch((error) => {
                if (disposed) return;
                const text = messageText(error);
                if (/不存在|无权|资源不存在|404/.test(text)) {
                    message.warning("关联详情页项目已失效，请重新选择商品和参考图");
                    const query = new URLSearchParams();
                    if (canvasId) query.set("canvasId", canvasId);
                    if (canvasNodeId) query.set("nodeId", canvasNodeId);
                    if (requestedProductId) query.set("productId", requestedProductId);
                    navigate(query.toString() ? `/detail-pages?${query.toString()}` : "/detail-pages", { replace: true });
                } else {
                    message.error(text);
                }
            })
            .finally(() => !disposed && setWorkspaceLoading(false));
        return () => {
            disposed = true;
        };
    }, [canvasId, canvasNodeId, initialProjectId, message, navigate, requestedProductId]);

    useEffect(() => {
        selectedProductIdRef.current = selectedProductId;
    }, [selectedProductId]);

    useEffect(() => {
        selectedTemplateIdRef.current = selectedTemplateId;
    }, [selectedTemplateId]);

    useEffect(() => {
        if (!selectedModel && defaultImageModel) setSelectedModel(defaultImageModel);
    }, [defaultImageModel, selectedModel]);

    useEffect(() => {
        if (!createOpen) return;
        let disposed = false;
        setProductLoading(true);
        void (async () => {
            const result = await listAllProducts({ owner: scope });
            let available = result.items.filter((item) => Boolean(item.resultImage));
            if (requestedProductId && !available.some((item) => item.id === requestedProductId)) {
                try {
                    const requested = await getProduct(requestedProductId);
                    if (requested.resultImage) available = [requested, ...available];
                    else message.warning("关联商品尚未生成四视角主图，请重新选择商品");
                } catch {
                    message.warning("关联商品已删除或无权访问，请重新选择商品");
                }
            }
            if (disposed) return;
            setProducts(available);
            const currentId = selectedProductIdRef.current;
            const nextId = requestedProductId && available.some((item) => item.id === requestedProductId) ? requestedProductId : available.some((item) => item.id === currentId) ? currentId : available[0]?.id || "";
            if (currentId && currentId !== nextId) {
                setDraftReferences([]);
                setSelectedTemplateId("");
                selectedTemplateIdRef.current = "";
            }
            selectedProductIdRef.current = nextId;
            setSelectedProductId(nextId);
        })()
            .catch((error) => !disposed && message.error(messageText(error)))
            .finally(() => !disposed && setProductLoading(false));
        return () => {
            disposed = true;
        };
    }, [createOpen, message, requestedProductId, scope]);

    useEffect(() => {
        if (!createOpen || !selectedProduct) {
            setTemplates([]);
            setTemplateLoading(false);
            return;
        }
        let disposed = false;
        const ownerId = selectedProduct.ownerId;
        setTemplateLoading(true);
        void listDetailPageTemplates({ owner: ownerId, page: 1, pageSize: 50 })
            .then((result) => {
                if (disposed) return;
                const available = result.items.filter((template) => template.ownerId === ownerId);
                setTemplates(available);
                if (selectedTemplateIdRef.current && !available.some((template) => template.id === selectedTemplateIdRef.current)) {
                    message.warning("原详情页模板已不存在、无权访问或媒体失效，请重新选择");
                    setSelectedTemplateId("");
                    selectedTemplateIdRef.current = "";
                }
            })
            .catch((error) => {
                if (disposed) return;
                setTemplates([]);
                setSelectedTemplateId("");
                selectedTemplateIdRef.current = "";
                message.error(messageText(error));
            })
            .finally(() => !disposed && setTemplateLoading(false));
        return () => {
            disposed = true;
        };
    }, [createOpen, message, selectedProduct?.id, selectedProduct?.ownerId]);

    useEffect(() => {
        if (initialProjectId || !requestedProductId) return;
        setCreateOpen(true);
    }, [initialProjectId, requestedProductId]);

    const openCreate = () => {
        setProject(null);
        setTitle("");
        setSelectedProductId(requestedProductId);
        selectedProductIdRef.current = requestedProductId;
        setDraftReferences([]);
        setSelectedTemplateId("");
        selectedTemplateIdRef.current = "";
        setTemplates([]);
        setCreateOpen(true);
    };

    const selectProduct = (value: string) => {
        if (value !== selectedProductId && draftReferences.length) {
            setDraftReferences([]);
            message.info("已清空原商品的参考图，请重新上传");
        }
        if (value !== selectedProductId) {
            setSelectedTemplateId("");
            selectedTemplateIdRef.current = "";
        }
        selectedProductIdRef.current = value;
        setSelectedProductId(value);
    };

    const applyTemplate = (template: DetailPageTemplate, confirmReplace = true) => {
        if (!selectedProduct || template.ownerId !== selectedProduct.ownerId) {
            setSelectedTemplateId("");
            selectedTemplateIdRef.current = "";
            return message.warning("该模板与当前商品不属于同一成员，请重新选择");
        }
        if (!template.references.length) {
            setSelectedTemplateId("");
            selectedTemplateIdRef.current = "";
            return message.warning("模板参考图已失效，请重新选择模板");
        }
        const apply = () => {
            setSelectedTemplateId(template.id);
            selectedTemplateIdRef.current = template.id;
            setDraftReferences(template.references.map((reference) => reference.image));
            message.success(`已载入「${template.name}」的 ${template.references.length} 张参考图`);
        };
        if (confirmReplace && draftReferences.length) {
            modal.confirm({ title: "替换当前参考图？", content: `选择「${template.name}」后，将用模板中的 ${template.references.length} 张图片替换当前参考图列表。`, okText: "确认替换", cancelText: "取消", onOk: apply });
        } else apply();
    };

    const selectTemplate = (templateId: string) => {
        if (!templateId) {
            selectedTemplateIdRef.current = "";
            return setSelectedTemplateId("");
        }
        const template = templates.find((item) => item.id === templateId);
        if (!template) {
            setSelectedTemplateId("");
            selectedTemplateIdRef.current = "";
            return message.warning("模板不存在或已无权访问，请重新选择");
        }
        if (template.id === selectedTemplateId) return;
        applyTemplate(template);
    };

    const templateSaved = (template: DetailPageTemplate) => {
        setTemplateEditorOpen(false);
        setTemplates((current) => [template, ...current.filter((item) => item.id !== template.id)]);
        applyTemplate(template, false);
    };

    const openProject = (id: string) => {
        const query = new URLSearchParams({ projectId: id });
        if (canvasId) query.set("canvasId", canvasId);
        if (canvasNodeId) query.set("nodeId", canvasNodeId);
        navigate(`/detail-pages?${query.toString()}`);
    };

    const addReferenceFiles = async (files: FileList | File[] | null) => {
        if (!selectedProduct) return message.warning("请先选择商品");
        if (selectedProduct.accessLevel !== "edit") return message.warning("你只有查看权限，不能上传参考图");
        const uploadProductId = selectedProduct.id;
        const uploadOwnerId = selectedProduct.ownerId;
        const incoming = Array.from(files || []);
        if (draftReferences.length >= MAX_REFERENCES) return message.warning(`最多上传 ${MAX_REFERENCES} 张参考详情页图片`);
        const accepted: File[] = [];
        for (const file of incoming) {
            if (!file.type.startsWith("image/")) {
                message.warning(`「${file.name}」不是图片文件`);
                continue;
            }
            if (file.size > MAX_IMAGE_BYTES) {
                message.warning(`「${file.name}」超过 20MB，无法上传`);
                continue;
            }
            accepted.push(file);
        }
        if (!accepted.length) return;
        const available = MAX_REFERENCES - draftReferences.length;
        if (accepted.length > available) message.warning(`最多上传 ${MAX_REFERENCES} 张，已忽略多余文件`);
        const uploaded: DraftReference[] = [];
        const failed: string[] = [];
        for (const file of accepted.slice(0, available)) {
            if (selectedProductIdRef.current !== uploadProductId) {
                message.info("商品已切换，已取消本次参考图上传");
                return;
            }
            try {
                const image = await uploadImage(file, uploadOwnerId);
                if (image.width > 0 && image.height > 0 && Math.max(image.width, image.height) / Math.min(image.width, image.height) > 3) {
                    message.warning(`「${file.name}」宽高比超过 3:1，请拆分成长图后再上传`);
                    continue;
                }
                const mediaId = image.storageKey.replace(/^media:/, "");
                uploaded.push({ id: mediaId, mediaId, fileName: file.name, mimeType: image.mimeType, bytes: image.bytes, url: image.url, thumbnailUrl: image.thumbnailUrl, storageKey: image.storageKey, width: image.width, height: image.height });
            } catch (error) {
                failed.push(`${file.name}：${messageText(error)}`);
            }
        }
        if (selectedProductIdRef.current !== uploadProductId) {
            message.info("商品已切换，已取消本次参考图上传");
            return;
        }
        if (uploaded.length) setDraftReferences((current) => [...current, ...uploaded].slice(0, MAX_REFERENCES));
        if (failed.length) message.error(failed.length === 1 ? failed[0] : `${failed.length} 张参考图上传失败：${failed.join("；")}`);
    };

    const createProject = async () => {
        if (!selectedProduct?.resultImage) return message.warning("请选择已有四视角主图的商品");
        if (selectedProduct.accessLevel !== "edit") return message.warning("你只有查看权限，不能创建详情页项目");
        if (!draftReferences.length) return message.warning("请至少上传 1 张参考详情页图片");
        setSaving(true);
        try {
            const result = await createDetailPageProject({ productId: selectedProduct.id, title: title.trim() || `${selectedProduct.name}-详情页`, referenceMediaIds: draftReferences.map((item) => item.mediaId) });
            setCreateOpen(false);
            setProject(result);
            if (canvasId && canvasNodeId) navigate(`/canvas/${canvasId}?projectId=${result.id}&nodeId=${canvasNodeId}`, { replace: true });
            else navigate(`/detail-pages?${new URLSearchParams({ projectId: result.id }).toString()}`, { replace: true });
            message.success("详情页复刻项目已创建");
        } catch (error) {
            message.error(messageText(error));
        } finally {
            setSaving(false);
        }
    };

    const replaceProject = (next: DetailPageProject) => {
        setProject(next);
        setProjects((current) => current.map((item) => (item.id === next.id ? next : item)));
    };

    const reloadProject = async () => {
        if (!project) return;
        try {
            replaceProject(await getDetailPageProject(project.id));
        } catch (error) {
            message.error(messageText(error));
        }
    };

    const runPersonalPair = async (targetProject: DetailPageProject, pair: DetailPagePair, model: string) => {
        if (runningRef.current.has(pair.id)) return;
        runningRef.current.add(pair.id);
        setPersonalRunning((current) => new Set(current).add(pair.id));
        setProject((current) => (current?.id === targetProject.id ? { ...current, status: "generating", pairs: current.pairs.map((item) => (item.id === pair.id ? { ...item, status: "running", error: undefined } : item)) } : current));
        let generationRevision = 0;
        try {
            const startedProject = await setDetailPagePairResult(targetProject.id, pair.id, { revision: pair.revision, status: "running", prompt: pair.prompt || productPrompt(targetProject.product), generationAspectRatio: pair.generationAspectRatio });
            const generationPair = startedProject.pairs.find((item) => item.id === pair.id);
            if (!generationPair) throw new Error("详情页配对不存在，请刷新后重试");
            generationRevision = generationPair.revision;
            setProject((current) => (current?.id === targetProject.id ? startedProject : current));
            const selectedReferences = (pair.references || []).filter((item) => item.selected).sort((a, b) => a.sortOrder - b.sortOrder);
            const imageInputs = [
                { id: `product-${targetProject.productMediaId}`, name: "商品四视角主图", image: targetProject.productImage },
                ...selectedReferences.map((item) => ({ id: item.mediaId, name: item.kind === "result" ? "当前生成图" : item.kind === "original" ? "原参考图" : "附加参考图", image: item.image })),
            ];
            const imageData = await Promise.all(imageInputs.map((item) => imageToDataUrl(item.image)));
            const config = { ...effectiveConfig, model, imageModel: model, count: "1", size: pairGenerationSize(pair), quality: pair.generationQuality || effectiveConfig.quality };
            const references: ReferenceImage[] = imageInputs.map((item, index) => ({ id: item.id, name: item.name, type: item.image.mimeType || "image/png", dataUrl: imageData[index], url: item.image.url, storageKey: item.image.storageKey }));
            const result = await requestEdit(config, generationPair.resolvedPrompt || generationPair.prompt || productPrompt(targetProject.product), references, undefined, { ownerId: targetProject.ownerId });
            const generated = result[0];
            if (!generated?.dataUrl) throw new Error("图片模型未返回生成结果");
            const uploaded = await uploadImage(generated.dataUrl, targetProject.ownerId);
            replaceProject(await setDetailPagePairResult(targetProject.id, pair.id, { revision: generationRevision, status: "succeeded", mediaId: uploaded.storageKey.replace(/^media:/, "") }));
        } catch (error) {
            message.error(messageText(error));
            if (generationRevision > 0) {
                try {
                    replaceProject(await setDetailPagePairResult(targetProject.id, pair.id, { revision: generationRevision, status: "failed", error: messageText(error) }));
                } catch {
                    /* 本次请求已过期时，不覆盖后来启动的生成结果。 */
                }
            } else {
                const latest = await getDetailPageProject(targetProject.id).catch(() => undefined);
                if (latest) replaceProject(latest);
            }
        } finally {
            runningRef.current.delete(pair.id);
            setPersonalRunning((current) => {
                const next = new Set(current);
                next.delete(pair.id);
                return next;
            });
        }
    };

    const generatePairsPersonally = async (targetProject: DetailPageProject, targets: DetailPagePair[], model: string) => {
        let cursor = 0;
        const worker = async () => {
            while (cursor < targets.length) {
                const pair = targets[cursor++];
                await runPersonalPair(targetProject, pair, model);
            }
        };
        await Promise.all(Array.from({ length: Math.min(3, targets.length) }, worker));
        await reloadProject();
    };

    const generate = async (pair?: DetailPagePair) => {
        if (!project) return;
        if (project.accessLevel === "view") return message.warning("你只有查看权限，不能生成");
        const model = pair?.generationModel || selectedModel || defaultImageModel;
        if (!model || !isAiConfigReady(effectiveConfig, model)) return openConfigDialog(true, "channels");
        const channel = resolveModelChannel(effectiveConfig, model);
        const targets = pair ? [pair] : project.pairs.filter((item) => item.status !== "succeeded" || !item.resultImage);
        if (!targets.length) return message.info("所有配对项都已生成，可重新生成单张");
        try {
            if (channel.source === "remote") {
                const channelId = channel.id.replace(/^server:/, "");
                const next = pair
                    ? await generateDetailPagePair(project.id, pair.id, { revision: pair.revision, model: modelOptionName(model), channelId })
                    : await generateDetailPageProject(project.id, { revision: project.revision, model: modelOptionName(model), channelId });
                replaceProject(next);
                message.success(pair ? "已提交单张生成任务" : "已提交全部生成任务");
            } else {
                message.info(`正在生成 ${targets.length} 张图片，最多并发 3 个请求`);
                void generatePairsPersonally(project, targets, model);
            }
        } catch (error) {
            message.error(messageText(error));
        }
    };

    const cancelPair = async (pair: DetailPagePair) => {
        if (!project || !pair.activeTaskId) return;
        if (pair.status !== "queued") return message.info("任务已开始运行，无法取消");
        try {
            replaceProject(await cancelDetailPagePair(project.id, pair.id, { revision: pair.revision }));
        } catch (error) {
            message.error(messageText(error));
        }
    };

    useEffect(() => {
        if (!project) return;
        const hasActive = project.pairs.some(
            (pair) => (pair.activeTaskId && (pair.status === "queued" || pair.status === "running")) || pair.modificationVariants.some((variant) => variant.activeTaskId && (variant.status === "queued" || variant.status === "running")),
        );
        if (!hasActive) return;
        const sync = async () => {
            try {
                const latest = await getDetailPageProject(project.id);
                setProject(latest);
            } catch {
                /* 页面暂时离线时保留当前状态，下一轮继续 */
            }
        };
        pollRef.current = window.setInterval(() => void sync(), 2_000);
        const onFocus = () => void sync();
        window.addEventListener("focus", onFocus);
        return () => {
            if (pollRef.current) window.clearInterval(pollRef.current);
            pollRef.current = null;
            window.removeEventListener("focus", onFocus);
        };
    }, [project?.id, project?.pairs]);

    useEffect(() => {
        if (!project || project.accessLevel !== "edit") return;
        const interrupted = project.pairs.flatMap((pair) => [
            ...(pair.status === "running" && !pair.activeTaskId && !runningRef.current.has(pair.id) ? [{ pair, variant: undefined }] : []),
            ...pair.modificationVariants.filter((variant) => variant.status === "running" && !variant.activeTaskId).map((variant) => ({ pair, variant })),
        ]);
        if (!interrupted.length) return;
        let disposed = false;
        void (async () => {
            for (const { pair, variant } of interrupted) {
                try {
                    const latest = await getDetailPageProject(project.id);
                    const current = latest.pairs.find((item) => item.id === pair.id);
                    if (!current) continue;
                    if (variant) {
                        const currentVariant = current.modificationVariants.find((item) => item.id === variant.id);
                        if (!currentVariant || currentVariant.status !== "running" || currentVariant.activeTaskId) continue;
                        await setDetailPagePairVariantResult(project.id, pair.id, currentVariant.id, { revision: currentVariant.revision, status: "interrupted", error: "页面刷新后浏览器直连修改已中断，请重新生成" });
                    } else {
                        if (current.status !== "running" || current.activeTaskId) continue;
                        await setDetailPagePairResult(project.id, pair.id, { revision: current.revision, status: "interrupted", error: "页面刷新后浏览器直连生成已中断，请重新生成" });
                    }
                } catch {
                    // 下一次进入项目时继续尝试标记中断。
                }
            }
            if (!disposed) await reloadProject();
        })();
        return () => {
            disposed = true;
        };
    }, [project?.id]);

    useEffect(
        () => () => {
            if (pollRef.current) window.clearInterval(pollRef.current);
        },
        [],
    );

    useEffect(() => {
        if (project) setTitle(project.title);
    }, [project?.id]);

    const saveTitle = async () => {
        if (!project || project.accessLevel !== "edit" || !title.trim() || title.trim() === project.title) return;
        try {
            replaceProject(await updateDetailPageProject(project.id, { revision: project.revision, title: title.trim() }));
            message.success("标题已保存");
        } catch (error) {
            message.error(messageText(error));
        }
    };

    const savePrompt = async () => {
        if (!project || project.accessLevel !== "edit" || !promptPair || !promptValue.trim()) return message.warning("提示词不能为空");
        setPromptSaving(true);
        try {
            const model = promptModel || selectedModel || defaultImageModel;
            const channel = model ? resolveModelChannel(effectiveConfig, model) : undefined;
            replaceProject(
                await updateDetailPagePairPrompt(project.id, promptPair.id, {
                    revision: promptPair.revision,
                    prompt: promptValue.trim(),
                    generationModel: model || undefined,
                    generationChannelId: channel?.id.replace(/^server:/, ""),
                    generationResolution: promptResolution,
                    generationAspectRatio: promptAspect,
                    generationQuality: promptQuality,
                }),
            );
            setPromptPair(null);
            message.success("提示词已保存");
        } catch (error) {
            message.error(messageText(error));
        } finally {
            setPromptSaving(false);
        }
    };

    const generatePromptPair = async () => {
        if (!project || !promptPair || project.accessLevel !== "edit" || !promptValue.trim()) return message.warning("提示词不能为空");
        const model = promptModel || selectedModel || defaultImageModel;
        if (!model || !isAiConfigReady(effectiveConfig, model)) return openConfigDialog(true, "channels");
        setPromptSaving(true);
        try {
            const channel = resolveModelChannel(effectiveConfig, model);
            const saved = await updateDetailPagePairPrompt(project.id, promptPair.id, {
                revision: promptPair.revision,
                prompt: promptValue.trim(),
                generationModel: model,
                generationChannelId: channel.id.replace(/^server:/, ""),
                generationResolution: promptResolution,
                generationAspectRatio: promptAspect,
                generationQuality: promptQuality,
            });
            replaceProject(saved);
            const current = saved.pairs.find((item) => item.id === promptPair.id);
            if (!current) throw new Error("详情页配对不存在，请刷新后重试");
            setPromptPair(null);
            if (channel.source === "remote") {
                replaceProject(
                    await generateDetailPagePair(project.id, current.id, {
                        revision: current.revision,
                        model: modelOptionName(model),
                        channelId: channel.id.replace(/^server:/, ""),
                        generationResolution: promptResolution,
                        generationAspectRatio: promptAspect,
                        generationQuality: promptQuality,
                    }),
                );
                message.success("已提交生成任务");
            } else {
                message.info("正在生成图片");
                void runPersonalPair(saved, current, model);
            }
        } catch (error) {
            message.error(messageText(error));
        } finally {
            setPromptSaving(false);
        }
    };

    const promptReferenceItems = useMemo(() => {
        if (!promptPair || !project) return [];
        const selected = (promptPair.references || []).filter((item) => item.selected).sort((a, b) => a.sortOrder - b.sortOrder);
        return [{ id: `product-${project.productMediaId}`, mediaId: project.productMediaId, kind: "product" as const, label: "商品主图", image: project.productImage }, ...selected];
    }, [project, promptPair]);

    const promptReferenceCandidates = useMemo<CanvasResourceReference[]>(
        () =>
            promptReferenceItems.map((item: any, index) => ({
                id: item.id,
                nodeId: item.id,
                kind: "image",
                label: item.kind === "product" ? "商品主图" : item.kind === "original" ? "原参考图" : item.kind === "result" ? "当前生成图" : `参考图${index}`,
                title: item.image.fileName,
                previewUrl: item.image.thumbnailUrl || item.image.url,
                active: true,
            })),
        [promptReferenceItems],
    );
    const promptReferenceAdditions = useMemo(() => (promptPair?.references || []).filter((item) => !item.selected), [promptPair]);

    const addExistingPromptReference = async (reference: NonNullable<DetailPagePair["references"]>[number]) => {
        if (!project || !promptPair) return;
        try {
            const next = await addDetailPagePairReference(project.id, promptPair.id, { revision: promptPair.revision, mediaId: reference.mediaId, kind: reference.kind });
            replaceProject(next);
            setPromptPair(next.pairs.find((item) => item.id === promptPair.id) || null);
        } catch (error) {
            message.error(messageText(error));
        }
    };

    const addPromptReferenceFile = async (file?: File) => {
        if (!project || !promptPair || !file) return;
        try {
            const uploaded = await uploadImage(file, project.ownerId);
            const next = await addDetailPagePairReference(project.id, promptPair.id, { revision: promptPair.revision, mediaId: uploaded.storageKey.replace(/^media:/, ""), kind: "upload" });
            replaceProject(next);
            setPromptPair(next.pairs.find((item) => item.id === promptPair.id) || null);
        } catch (error) {
            message.error(messageText(error));
        }
    };

    const removePromptReference = async (referenceId: string) => {
        if (!project || !promptPair) return;
        try {
            const next = await deleteDetailPagePairReference(project.id, promptPair.id, referenceId, promptPair.revision);
            replaceProject(next);
            setPromptPair(next.pairs.find((item) => item.id === promptPair.id) || null);
        } catch (error) {
            message.error(messageText(error));
        }
    };

    const resetPrompt = async (pair: DetailPagePair) => {
        if (!project || project.accessLevel !== "edit") return;
        try {
            replaceProject(await updateDetailPagePairPrompt(project.id, pair.id, { revision: pair.revision, prompt: productPrompt(project.product) }));
            message.success("已恢复默认提示词");
        } catch (error) {
            message.error(messageText(error));
        }
    };

    const createPersonalVariant = async (pair: DetailPagePair, kind: "retry" | "result_retry" | "mask_edit", payload?: CanvasImageMaskEditPayload) => {
        if (!project || !pair.resultImage || project.accessLevel !== "edit") return;
        const model = pair.generationModel || selectedModel || defaultImageModel;
        if (!model || !isAiConfigReady(effectiveConfig, model)) return openConfigDialog(true, "channels");
        const created = await createDetailPagePairVariant(project.id, pair.id, { revision: pair.revision, kind, mode: "personal", sourceMediaId: kind === "mask_edit" || kind === "result_retry" ? pair.resultMediaId : undefined, prompt: payload?.prompt });
        replaceProject(created.project);
        const variant = created.project.pairs.find((item) => item.id === pair.id)?.modificationVariants.find((item) => item.id === created.variantId);
        if (!variant) throw new Error("修改图版本创建失败");
        try {
            const selectedReferences = (pair.references || []).filter((item) => item.selected).sort((a, b) => a.sortOrder - b.sortOrder);
            const [productData, referenceData, sourceData, maskData, ...attachmentData] = await Promise.all([
                imageToDataUrl(project.productImage),
                imageToDataUrl(pair.referenceImage),
                imageToDataUrl(pair.resultImage),
                payload?.maskDataUrl ? Promise.resolve(payload.maskDataUrl) : Promise.resolve(undefined),
                ...selectedReferences.map((item) => imageToDataUrl(item.image)),
            ]);
            const config = { ...effectiveConfig, model, imageModel: model, count: "1", size: pairGenerationSize(pair), quality: pair.generationQuality || effectiveConfig.quality };
            const references: ReferenceImage[] =
                kind === "mask_edit"
                    ? [{ id: `detail-result-${pair.resultMediaId}`, name: "当前正式生成图", type: pair.resultImage.mimeType || "image/png", dataUrl: sourceData, url: pair.resultImage.url, storageKey: pair.resultImage.storageKey }]
                    : [
                          { id: `product-${project.productMediaId}`, name: "商品四视角主图", type: project.productImage.mimeType || "image/png", dataUrl: productData, url: project.productImage.url, storageKey: project.productImage.storageKey },
                          ...selectedReferences.map((item, index) => ({
                              id: item.mediaId,
                              name: item.kind === "result" ? "当前正式生成图" : item.kind === "original" ? "原参考图" : "附加参考图",
                              type: item.image.mimeType || "image/png",
                              dataUrl: item.kind === "result" ? sourceData : item.kind === "original" ? referenceData : attachmentData[index],
                              url: item.image.url,
                              storageKey: item.image.storageKey,
                          })),
                      ];
            const maskReference = maskData ? { id: `detail-mask-${created.variantId}`, name: "局部编辑蒙版", type: "image/png", dataUrl: maskData, url: maskData } : undefined;
            const result = await requestEdit(
                config,
                `${kind === "result_retry" ? "图一是我们的商品四视角主图，图二是当前正式生成图。以商品图为唯一主体，参考当前生成图的构图、排版和视觉风格重新生成，优化当前结果并保留商品真实外形、材质、卖点和自身品牌。\n" : ""}${variant.resolvedPrompt || variant.prompt}${kind === "mask_edit" ? "\n只修改蒙版透明区域，其他区域保持不变。" : ""}`,
                references,
                maskReference,
                { ownerId: project.ownerId },
            );
            const generated = result[0];
            if (!generated?.dataUrl) throw new Error("图片模型未返回生成结果");
            const uploaded = await uploadImage(generated.dataUrl, project.ownerId);
            replaceProject(await setDetailPagePairVariantResult(project.id, pair.id, created.variantId, { revision: variant.revision, status: "succeeded", mediaId: uploaded.storageKey.replace(/^media:/, "") }));
        } catch (error) {
            await setDetailPagePairVariantResult(project.id, pair.id, created.variantId, { revision: variant.revision, status: "failed", error: messageText(error) })
                .then(replaceProject)
                .catch(() => undefined);
            throw error;
        }
    };

    const retryVariant = async (pair: DetailPagePair) => {
        if (!project || !pair.resultImage) return generate(pair);
        const model = pair.generationModel || selectedModel || defaultImageModel;
        if (!model || !isAiConfigReady(effectiveConfig, model)) return openConfigDialog(true, "channels");
        const channel = resolveModelChannel(effectiveConfig, model);
        try {
            if (channel.source === "remote") {
                const created = await createDetailPagePairVariant(project.id, pair.id, { revision: pair.revision, kind: "retry", mode: "remote", model: modelOptionName(model), channelId: channel.id.replace(/^server:/, "") });
                replaceProject(created.project);
                message.success("已提交修改图生成任务");
            } else {
                await createPersonalVariant(pair, "retry");
                message.success("修改图生成完成");
            }
        } catch (error) {
            message.error(messageText(error));
        }
    };

    const retryFromResult = async (pair: DetailPagePair) => {
        if (!project || !pair.resultImage || !pair.resultMediaId) return;
        const model = pair.generationModel || selectedModel || defaultImageModel;
        if (!model || !isAiConfigReady(effectiveConfig, model)) return openConfigDialog(true, "channels");
        const channel = resolveModelChannel(effectiveConfig, model);
        try {
            if (channel.source === "remote") {
                const created = await createDetailPagePairVariant(project.id, pair.id, {
                    revision: pair.revision,
                    kind: "result_retry",
                    mode: "remote",
                    model: modelOptionName(model),
                    channelId: channel.id.replace(/^server:/, ""),
                    sourceMediaId: pair.resultMediaId,
                });
                replaceProject(created.project);
                message.success("已提交按生成图重试任务");
            } else {
                await createPersonalVariant(pair, "result_retry");
                message.success("按生成图重试完成");
            }
        } catch (error) {
            message.error(messageText(error));
        }
    };

    const confirmMaskEdit = async (payload: CanvasImageMaskEditPayload) => {
        const editingPair = maskEditPair;
        if (!editingPair) return;
        setMaskEditPair(null);
        try {
            if (!project) return;
            const model = selectedModel || defaultImageModel;
            if (!model || !isAiConfigReady(effectiveConfig, model)) {
                openConfigDialog(true, "channels");
                return;
            }
            const channel = resolveModelChannel(effectiveConfig, model);
            if (channel.source === "remote") {
                const mask = await uploadImage(payload.maskDataUrl, project.ownerId);
                const created = await createDetailPagePairVariant(project.id, editingPair.id, {
                    revision: editingPair.revision,
                    kind: "mask_edit",
                    mode: "remote",
                    model: modelOptionName(model),
                    channelId: channel.id.replace(/^server:/, ""),
                    sourceMediaId: editingPair.resultMediaId,
                    maskMediaId: mask.storageKey.replace(/^media:/, ""),
                    prompt: payload.prompt,
                });
                replaceProject(created.project);
                message.success("已提交局部编辑任务");
            } else {
                await createPersonalVariant(editingPair, "mask_edit", payload);
                message.success("局部修改图生成完成");
            }
        } catch (error) {
            message.error(messageText(error));
        }
    };

    const startMaskEdit = (pair: DetailPagePair) => {
        if (!pair.resultImage) return message.info("请先生成正式图");
        setMaskEditPair(pair);
    };

    const promoteVariant = async (pair: DetailPagePair, variant: DetailPagePairVariant) => {
        if (!project || project.accessLevel !== "edit") return;
        try {
            replaceProject(await promoteDetailPagePairVariant(project.id, pair.id, variant.id, variant.revision));
            message.success("修改图已覆盖正式生成图");
        } catch (error) {
            message.error(messageText(error));
        }
    };

    const deleteVariant = async (pair: DetailPagePair, variant: DetailPagePairVariant) => {
        if (!project || project.accessLevel !== "edit") return;
        try {
            await deleteDetailPagePairVariant(project.id, pair.id, variant.id);
            replaceProject(await getDetailPageProject(project.id));
            message.success("历史图片已删除");
        } catch (error) {
            message.error(messageText(error));
        }
    };

    const cancelVariant = async (pair: DetailPagePair, variant: DetailPagePairVariant) => {
        if (!project || project.accessLevel !== "edit") return;
        try {
            replaceProject(await cancelDetailPagePairVariant(project.id, pair.id, variant.id));
            message.success("修改图任务已取消");
        } catch (error) {
            message.error(messageText(error));
        }
    };

    const downloadPair = async (pair: DetailPagePair) => {
        if (!pair.resultImage?.url) return;
        try {
            saveAs(await (await fetch(pair.resultImage.url)).blob(), `${project?.title || "详情页"}-${pair.sortOrder + 1}.png`);
        } catch {
            message.error("下载图片失败");
        }
    };

    const downloadAll = async () => {
        if (!project) return;
        const results = project.pairs.filter((pair) => pair.resultImage?.url);
        if (!results.length) return message.warning("暂无可下载的生成图");
        try {
            const images = await Promise.all(results.map((pair) => loadImage(pair.resultImage!.url)));
            const naturalWidth = Math.max(...images.map((image) => image.naturalWidth || image.width));
            const naturalHeight = images.reduce((sum, image) => sum + ((image.naturalHeight || image.height) * naturalWidth) / Math.max(1, image.naturalWidth || image.width), 0);
            const scale = Math.min(1, Math.sqrt(20_000_000 / Math.max(1, naturalWidth * naturalHeight)), 32_767 / Math.max(1, naturalHeight));
            const canvas = document.createElement("canvas");
            canvas.width = Math.max(1, Math.floor(naturalWidth * scale));
            canvas.height = Math.max(1, Math.floor(naturalHeight * scale));
            const context = canvas.getContext("2d");
            if (!context) throw new Error("浏览器不支持长图拼接");
            let y = 0;
            images.forEach((image) => {
                const height = (((image.naturalHeight || image.height) * naturalWidth) / Math.max(1, image.naturalWidth || image.width)) * scale;
                context.drawImage(image, 0, y, naturalWidth * scale, height);
                y += height;
            });
            const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => (value ? resolve(value) : reject(new Error("长图导出失败"))), "image/png"));
            saveAs(blob, `${project.title || "详情页复刻"}-长图.png`);
        } catch (error) {
            message.error(messageText(error));
        }
    };

    const deleteProject = () => {
        if (!project) return;
        modal.confirm({
            title: `删除「${project.title}」？`,
            content: "只删除项目和配对关联，不删除参考图、生成图或画布中的静态节点。",
            okText: "删除",
            okButtonProps: { danger: true },
            cancelText: "取消",
            onOk: async () => {
                try {
                    await deleteDetailPageProject(project.id, project.revision);
                    setProject(null);
                    message.success("项目已删除");
                    navigate(canvasId ? `/canvas/${canvasId}` : "/detail-pages");
                } catch (error) {
                    message.error(messageText(error));
                }
            },
        });
    };

    const leaveWorkspace = () => {
        setProject(null);
        setPromptPair(null);
        setTitle("");
        navigate(canvasId ? `/canvas/${canvasId}` : "/detail-pages");
    };

    if (workspaceLoading)
        return (
            <div className="grid h-full place-items-center bg-background">
                <Spin />
            </div>
        );

    if (project)
        return (
            <>
                <ProjectWorkspace
                    project={project}
                    selectedModel={selectedModel || defaultImageModel}
                    effectiveConfig={effectiveConfig}
                    onBack={leaveWorkspace}
                    onTitleChange={setTitle}
                    titleValue={title || project.title}
                    onSaveTitle={() => void saveTitle()}
                    onGenerate={(pair) => void (pair ? retryVariant(pair) : generate())}
                    onRetryFromResult={(pair) => void retryFromResult(pair)}
                    onCancel={cancelPair}
                    onOpenPrompt={(pair) => {
                        setPromptPair(pair);
                        setPromptValue(pair.prompt || productPrompt(project.product));
                        setPromptModel(pair.generationModel || selectedModel || defaultImageModel);
                        setPromptResolution(pair.generationResolution || "1k");
                        setPromptAspect(pair.generationAspectRatio || "original");
                        setPromptQuality(pair.generationQuality || "auto");
                    }}
                    onResetPrompt={(pair) => void resetPrompt(pair)}
                    onDownloadPair={(pair) => void downloadPair(pair)}
                    onDownloadAll={() => void downloadAll()}
                    onDelete={deleteProject}
                    onModelChange={setSelectedModel}
                    onMissingModel={() => openConfigDialog(true, "channels")}
                    personalRunning={personalRunning}
                    onLocalEdit={startMaskEdit}
                    onPromoteVariant={promoteVariant}
                    onDeleteVariant={deleteVariant}
                    onCancelVariant={cancelVariant}
                    onSelectVariant={(pairId, variantId) => setSelectedVariantIds((current) => ({ ...current, [pairId]: variantId }))}
                    selectedVariantIds={selectedVariantIds}
                />
                <Modal
                    open={Boolean(promptPair)}
                    width={760}
                    title="编辑完整提示词"
                    destroyOnHidden
                    onCancel={() => setPromptPair(null)}
                    footer={[
                        <Button key="cancel" onClick={() => setPromptPair(null)}>
                            取消
                        </Button>,
                        <Button key="save" onClick={() => void savePrompt()}>
                            保存提示词
                        </Button>,
                        <Button key="generate" type="primary" loading={promptSaving} disabled={project.accessLevel !== "edit" || !promptValue.trim() || !promptResolution} onClick={() => void generatePromptPair()}>
                            生成
                        </Button>,
                    ]}
                >
                    <div className="mb-3 flex items-center gap-2 overflow-x-auto border-b border-border pb-3">
                        <div className="relative shrink-0">
                            <img src={project.productImage.thumbnailUrl || project.productImage.url} alt="" className="size-12 rounded-lg object-contain" />
                            <span className="absolute bottom-0 left-0 bg-black/60 px-1 text-[10px] text-white">商品</span>
                        </div>
                        {promptReferenceItems
                            .filter((item: any) => item.kind !== "product")
                            .map((item: any) => (
                                <div key={item.id} className="group relative shrink-0">
                                    <img src={item.image.thumbnailUrl || item.image.url} alt="" className="size-12 rounded-lg object-contain" />
                                    <button
                                        type="button"
                                        aria-label="移除参考素材"
                                        className="absolute -right-1 -top-1 grid size-4 place-items-center rounded-full bg-black/70 text-white opacity-0 transition group-hover:opacity-100"
                                        onClick={() => void removePromptReference(item.id)}
                                    >
                                        <X className="size-3" />
                                    </button>
                                    <span className="absolute bottom-0 left-0 max-w-12 truncate bg-black/60 px-1 text-[10px] text-white">{item.kind === "original" ? "原参考" : item.kind === "result" ? "当前图" : "参考"}</span>
                                </div>
                            ))}
                        <Popover
                            trigger="click"
                            content={
                                <div className="w-56 space-y-1">
                                    {promptReferenceAdditions.length ? (
                                        promptReferenceAdditions.map((item) => (
                                            <Button key={item.id} type="text" block className="!justify-start" onClick={() => void addExistingPromptReference(item)}>
                                                <img src={item.image.thumbnailUrl || item.image.url} alt="" className="mr-2 size-7 rounded object-cover" />
                                                {item.kind === "original" ? "原参考图" : item.kind === "result" ? "当前生成图" : "附加参考图"}
                                            </Button>
                                        ))
                                    ) : (
                                        <div className="px-2 py-1 text-xs text-muted-foreground">暂无可恢复素材</div>
                                    )}
                                    <Button type="link" size="small" icon={<Upload className="size-3.5" />} onClick={() => promptReferenceInput?.click()}>
                                        上传新参考图
                                    </Button>
                                </div>
                            }
                        >
                            <Button type="dashed" icon={<Plus className="size-4" />}>
                                添加
                            </Button>
                        </Popover>
                        <input
                            ref={setPromptReferenceInput}
                            type="file"
                            accept="image/*"
                            hidden
                            onChange={(event) => {
                                void addPromptReferenceFile(event.target.files?.[0]);
                                event.target.value = "";
                            }}
                        />
                    </div>
                    <p className="mb-3 text-xs leading-5 text-muted-foreground">服务端生成时会替换商品资料变量，并追加最新品牌、材质、卖点及人物安全约束。参考图有人物时保留姿态，但会替换为相近气质的全新面孔，不复刻原人物身份。</p>
                    <CanvasPromptChipInput
                        value={promptValue}
                        references={promptReferenceCandidates}
                        onChange={setPromptValue}
                        placeholder="输入提示词，按 @ 选择参考图片"
                        className="min-h-[320px] rounded-lg border border-border p-3 text-sm leading-6"
                        style={{ maxHeight: 420 }}
                    />
                    <div className="mt-3 grid grid-cols-1 gap-2 rounded-lg border border-border p-3 sm:grid-cols-[1.3fr_1fr_1fr_1fr]">
                        <ModelPicker config={effectiveConfig} value={promptModel} capability="image" onChange={setPromptModel} onMissingConfig={() => openConfigDialog(true, "channels")} />
                        <Select value={promptResolution} options={PROMPT_RESOLUTIONS.map((value) => ({ value, label: value }))} onChange={setPromptResolution} />
                        <Select value={promptAspect} disabled={!promptResolution} options={PROMPT_ASPECTS.map((value) => ({ value, label: PROMPT_ASPECT_LABELS[value] || value }))} onChange={setPromptAspect} />
                        <Select value={promptQuality} options={PROMPT_QUALITIES.map((value) => ({ value, label: value }))} onChange={setPromptQuality} />
                        <div className="text-xs text-muted-foreground sm:col-span-4">{promptPair ? `实际尺寸：${promptPixelSize(promptPair, promptResolution, promptAspect)}` : ""}</div>
                    </div>
                </Modal>
                <CanvasNodeMaskEditDialog dataUrl={maskEditPair?.resultImage?.url || ""} open={Boolean(maskEditPair)} onClose={() => setPromptPair(null)} onConfirm={(payload) => void confirmMaskEdit(payload)} />
            </>
        );

    return (
        <div className="h-full overflow-y-auto bg-background text-foreground">
            <div className="mx-auto max-w-[1500px] px-6 py-8">
                <div className="flex flex-wrap items-end justify-between gap-4">
                    <div>
                        <div className="flex items-center gap-3">
                            <div className="grid size-10 place-items-center rounded-2xl bg-foreground text-background">
                                <FileImage className="size-5" />
                            </div>
                            <div>
                                <h1 className="text-3xl font-semibold tracking-tight">详情页复刻</h1>
                                <p className="mt-1 text-sm text-muted-foreground">一张商品四视角主图，对应一张参考详情页，逐张生成可控结果。</p>
                            </div>
                        </div>
                    </div>
                    <OwnerScopePicker />
                </div>
                <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
                    <Input className="w-full max-w-sm" value={keyword} onChange={(event) => setKeyword(event.target.value)} allowClear prefix={<Search className="size-4 text-muted-foreground" />} placeholder="搜索项目标题或商品名称" />
                    <Button type="primary" icon={<Plus className="size-4" />} disabled={!scopeCanEdit} onClick={openCreate}>
                        新建复刻项目
                    </Button>
                </div>
                {loading && !projects.length ? (
                    <div className="grid min-h-64 place-items-center">
                        <Spin />
                    </div>
                ) : null}
                {!loading && !projects.length ? <Empty className="py-24" image={<FileImage className="mx-auto size-12 text-muted-foreground" />} description={searchKeyword ? "没有找到匹配的项目" : "还没有详情页复刻项目"} /> : null}
                {projects.length ? (
                    <>
                        <div className="mt-6 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
                            {projects.map((item) => (
                                <ProjectCard key={item.id} project={item} onOpen={() => openProject(item.id)} />
                            ))}
                        </div>
                        {projectTotal > PROJECT_PAGE_SIZE ? (
                            <div className="mt-8 flex justify-center">
                                <Pagination current={projectPage} pageSize={PROJECT_PAGE_SIZE} total={projectTotal} showSizeChanger={false} onChange={setProjectPage} />
                            </div>
                        ) : null}
                    </>
                ) : null}
            </div>
            <CreateProjectModal
                open={createOpen}
                title={title}
                setTitle={setTitle}
                products={products}
                selectedProductId={selectedProductId}
                setSelectedProductId={selectProduct}
                references={draftReferences}
                setReferences={setDraftReferences}
                templates={templates}
                selectedTemplateId={selectedTemplateId}
                templateLoading={templateLoading}
                productLoading={productLoading}
                saving={saving}
                fileInputRef={fileInputRef}
                onSelectTemplate={selectTemplate}
                onCreateTemplate={() => setTemplateEditorOpen(true)}
                onAddFiles={(files) => void addReferenceFiles(files)}
                onClose={() => {
                    setCreateOpen(false);
                    setTemplateEditorOpen(false);
                    setTitle("");
                    setDraftReferences([]);
                    setSelectedTemplateId("");
                    selectedTemplateIdRef.current = "";
                }}
                onCreate={() => void createProject()}
            />
            <DetailPageTemplateEditor open={templateEditorOpen} template={null} ownerId={selectedProduct?.ownerId || ""} canEdit={selectedProduct?.accessLevel === "edit"} onClose={() => setTemplateEditorOpen(false)} onSaved={templateSaved} />
        </div>
    );
}

function ProjectCard({ project, onOpen }: { project: DetailPageProject; onOpen: () => void }) {
    const cover = project.pairs.find((pair) => pair.resultImage)?.resultImage || project.pairs[0]?.referenceImage || project.productImage;
    const completed = project.pairs.filter((pair) => pair.status === "succeeded" && pair.resultImage).length;
    return (
        <button type="button" className="group overflow-hidden rounded-2xl border border-border bg-card text-left transition hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-lg" onClick={onOpen}>
            <div className="relative aspect-[4/3] overflow-hidden bg-muted">
                {cover?.url ? (
                    <img src={mediaSrc(cover)} alt="" className="size-full object-contain transition duration-300 group-hover:scale-[1.02]" />
                ) : (
                    <div className="grid size-full place-items-center text-muted-foreground">
                        <FileImage className="size-9" />
                    </div>
                )}
                <Tag color={projectTagColor(project.status)} className="absolute left-3 top-3">
                    {projectStatusText(project.status)}
                </Tag>
            </div>
            <div className="space-y-2 p-4">
                <div className="truncate font-medium">{project.title}</div>
                <ProductSummary product={project.product} />
                <div className="text-xs text-muted-foreground">
                    {completed}/{project.pairs.length} 张已完成 · {project.ownerUsername}
                </div>
            </div>
        </button>
    );
}

function CreateProjectModal({
    open,
    title,
    setTitle,
    products,
    selectedProductId,
    setSelectedProductId,
    references,
    setReferences,
    templates,
    selectedTemplateId,
    templateLoading,
    productLoading,
    saving,
    fileInputRef,
    onSelectTemplate,
    onCreateTemplate,
    onAddFiles,
    onClose,
    onCreate,
}: {
    open: boolean;
    title: string;
    setTitle: (value: string) => void;
    products: Product[];
    selectedProductId: string;
    setSelectedProductId: (value: string) => void;
    references: DraftReference[];
    setReferences: Dispatch<SetStateAction<DraftReference[]>>;
    templates: DetailPageTemplate[];
    selectedTemplateId: string;
    templateLoading: boolean;
    productLoading: boolean;
    saving: boolean;
    fileInputRef: RefObject<HTMLInputElement | null>;
    onSelectTemplate: (templateId: string) => void;
    onCreateTemplate: () => void;
    onAddFiles: (files: FileList | null) => void;
    onClose: () => void;
    onCreate: () => void;
}) {
    const selected = products.find((item) => item.id === selectedProductId);
    const canEdit = selected?.accessLevel === "edit";
    return (
        <Modal
            open={open}
            width={860}
            title="新建详情页复刻"
            destroyOnHidden
            onCancel={onClose}
            footer={[
                <Button key="cancel" onClick={onClose}>
                    取消
                </Button>,
                <Button key="create" type="primary" loading={saving} disabled={!canEdit || !selected?.resultImage || !references.length} onClick={onCreate}>
                    创建项目
                </Button>,
            ]}
        >
            <div className="space-y-6">
                <div>
                    <div className="mb-2 text-sm font-medium">商品</div>
                    {productLoading ? (
                        <div className="grid h-20 place-items-center">
                            <Spin />
                        </div>
                    ) : products.length ? (
                        <ProductSelect className="w-full" products={products} value={selectedProductId} onChange={setSelectedProductId} placeholder="选择已有四视角主图的商品" />
                    ) : (
                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无已生成四视角主图的商品，请先到商品图模块生成" />
                    )}
                    {selected ? (
                        <div className="mt-3 rounded-xl border border-border bg-muted/30 p-3">
                            <ProductSummary product={selected} large />
                            <div className="mt-3 flex flex-wrap gap-1">
                                {selected.sellingPoints.map((point) => (
                                    <Tag key={point} className="m-0">
                                        {point}
                                    </Tag>
                                ))}
                            </div>
                            {selected.material ? <div className="mt-2 text-xs text-muted-foreground">材质：{selected.material}</div> : null}
                        </div>
                    ) : null}
                </div>
                <div>
                    <div className="mb-2 flex items-center justify-between gap-3">
                        <span className="text-sm font-medium">详情页模板（可选）</span>
                        <Button type="text" size="small" icon={<Plus className="size-4" />} disabled={!canEdit} onClick={onCreateTemplate}>
                            添加新的模板
                        </Button>
                    </div>
                    <TemplateSelect templates={templates} value={selectedTemplateId} loading={templateLoading} disabled={!selected} onChange={onSelectTemplate} />
                    <p className="mt-2 text-xs leading-5 text-muted-foreground">选择模板会载入其参考图快照；你仍可继续删除、排序或追加图片，模板后续修改不会影响已创建项目。</p>
                </div>
                <div>
                    <div className="mb-2 flex items-center justify-between text-sm font-medium">
                        <span>
                            参考详情页图片（{references.length}/{MAX_REFERENCES}）
                        </span>
                        <Button type="text" size="small" icon={<Upload className="size-4" />} disabled={!canEdit || references.length >= MAX_REFERENCES} onClick={() => fileInputRef.current?.click()}>
                            上传图片
                        </Button>
                    </div>
                    <p className="mb-3 text-xs leading-5 text-muted-foreground">每张参考图对应一张生成图；支持 1–18 张，单张不超过 20MB，宽高比不能超过 3:1。</p>
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept="image/*"
                        multiple
                        className="hidden"
                        onChange={(event) => {
                            onAddFiles(event.target.files);
                            event.target.value = "";
                        }}
                    />
                    <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
                        {references.map((image, index) => (
                            <div key={image.mediaId} className="group relative overflow-hidden rounded-xl border border-border bg-muted" style={{ aspectRatio: `${image.width || 2} / ${image.height || 3}` }}>
                                <img src={image.thumbnailUrl || image.url} alt={image.fileName} className="size-full object-contain" />
                                <div className="absolute left-1 top-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white">{index + 1}</div>
                                <button
                                    type="button"
                                    aria-label={`删除第 ${index + 1} 张参考图`}
                                    className="absolute right-1 top-1 grid size-6 place-items-center rounded-full bg-black/60 text-white opacity-0 transition group-hover:opacity-100"
                                    onClick={() => setReferences((current) => current.filter((item) => item.mediaId !== image.mediaId))}
                                >
                                    <X className="size-3.5" />
                                </button>
                                <div className="absolute inset-x-1 bottom-1 flex justify-between opacity-0 transition group-hover:opacity-100">
                                    <button
                                        type="button"
                                        aria-label="向前移动"
                                        disabled={index === 0}
                                        className="grid size-6 place-items-center rounded bg-black/60 text-white disabled:opacity-30"
                                        onClick={() => setReferences((current) => moveItem(current, index, -1))}
                                    >
                                        <ChevronLeft className="size-3.5" />
                                    </button>
                                    <button
                                        type="button"
                                        aria-label="向后移动"
                                        disabled={index === references.length - 1}
                                        className="grid size-6 place-items-center rounded bg-black/60 text-white disabled:opacity-30"
                                        onClick={() => setReferences((current) => moveItem(current, index, 1))}
                                    >
                                        <ChevronRight className="size-3.5" />
                                    </button>
                                </div>
                            </div>
                        ))}
                        {canEdit && references.length < MAX_REFERENCES ? (
                            <button
                                type="button"
                                className="flex min-h-28 flex-col items-center justify-center rounded-xl border border-dashed border-border text-xs text-muted-foreground transition hover:border-primary hover:text-primary"
                                onClick={() => fileInputRef.current?.click()}
                            >
                                <ImagePlus className="mb-2 size-5" />
                                添加参考图
                            </button>
                        ) : null}
                    </div>
                </div>
                <div>
                    <div className="mb-2 text-sm font-medium">项目标题</div>
                    <Input value={title} maxLength={120} showCount onChange={(event) => setTitle(event.target.value)} placeholder={selected ? `${selected.name}-详情页` : "例如：夏季新品详情页"} />
                </div>
            </div>
        </Modal>
    );
}

function ProjectWorkspace({
    project,
    selectedModel,
    effectiveConfig,
    titleValue,
    onTitleChange,
    onSaveTitle,
    onBack,
    onGenerate,
    onRetryFromResult,
    onCancel,
    onOpenPrompt,
    onResetPrompt,
    onDownloadPair,
    onDownloadAll,
    onDelete,
    onModelChange,
    onMissingModel,
    personalRunning,
    onLocalEdit,
    onPromoteVariant,
    onDeleteVariant,
    onCancelVariant,
    onSelectVariant,
    selectedVariantIds,
}: {
    project: DetailPageProject;
    selectedModel: string;
    effectiveConfig: ReturnType<typeof useEffectiveConfig>;
    titleValue: string;
    onTitleChange: (value: string) => void;
    onSaveTitle: () => void;
    onBack: () => void;
    onGenerate: (pair?: DetailPagePair) => void;
    onRetryFromResult: (pair: DetailPagePair) => void;
    onCancel: (pair: DetailPagePair) => void;
    onOpenPrompt: (pair: DetailPagePair) => void;
    onResetPrompt: (pair: DetailPagePair) => void;
    onDownloadPair: (pair: DetailPagePair) => void;
    onDownloadAll: () => void;
    onDelete: () => void;
    onModelChange: (value: string) => void;
    onMissingModel: () => void;
    personalRunning: Set<string>;
    onLocalEdit: (pair: DetailPagePair) => void;
    onPromoteVariant: (pair: DetailPagePair, variant: DetailPagePairVariant) => void;
    onDeleteVariant: (pair: DetailPagePair, variant: DetailPagePairVariant) => void;
    onCancelVariant: (pair: DetailPagePair, variant: DetailPagePairVariant) => void;
    onSelectVariant: (pairId: string, variantId: string) => void;
    selectedVariantIds: Record<string, string>;
}) {
    const canEdit = project.accessLevel === "edit";
    const completed = project.pairs.filter((pair) => pair.status === "succeeded" && pair.resultImage).length;
    return (
        <div className="h-full overflow-y-auto bg-background text-foreground">
            <div className="mx-auto max-w-[1700px] px-4 py-5 sm:px-6">
                <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border pb-5">
                    <div className="flex min-w-0 items-center gap-3">
                        <Button type="text" icon={<ArrowLeft className="size-4" />} onClick={onBack}>
                            返回项目
                        </Button>
                        <div className="h-6 w-px bg-border" />
                        <Input
                            variant="borderless"
                            readOnly={!canEdit}
                            className="!w-[min(36rem,70vw)] !px-0 text-xl font-semibold"
                            value={titleValue}
                            onChange={(event) => onTitleChange(event.target.value)}
                            onBlur={onSaveTitle}
                            onPressEnter={onSaveTitle}
                        />
                        <Tag color={projectTagColor(project.status)}>{projectStatusText(project.status)}</Tag>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        <Tooltip title="图片模型">
                            <ModelPicker config={effectiveConfig} value={selectedModel} capability="image" onChange={onModelChange} onMissingConfig={onMissingModel} />
                        </Tooltip>
                        <Button type="primary" icon={<Sparkles className="size-4" />} disabled={!canEdit || !project.pairs.some((pair) => pair.status !== "succeeded" || !pair.resultImage)} onClick={() => onGenerate()}>
                            全部生成
                        </Button>
                        <Button icon={<Download className="size-4" />} disabled={!completed} onClick={onDownloadAll}>
                            下载长图
                        </Button>
                        <Button danger type="text" icon={<Trash2 className="size-4" />} disabled={!canEdit} onClick={onDelete}>
                            删除
                        </Button>
                    </div>
                </div>
                <div className="mt-5 grid gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
                    <aside className="lg:sticky lg:top-4 lg:self-start">
                        <div className="rounded-2xl border border-border bg-card p-4">
                            <div className="mb-3 text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">我的商品</div>
                            <div className="overflow-hidden rounded-xl border border-border bg-muted">
                                {project.productImage.url ? (
                                    <Image
                                        rootClassName="!block !h-full !w-full"
                                        src={project.productImage.thumbnailUrl || project.productImage.url}
                                        preview={{ src: project.productImage.url, mask: "查看原图" }}
                                        className="!block aspect-square !h-full !w-full [&_.ant-image-img]:!h-full [&_.ant-image-img]:!w-full [&_.ant-image-img]:!object-contain"
                                    />
                                ) : (
                                    <div className="grid aspect-square place-items-center text-muted-foreground">
                                        <PackageOpen className="size-9" />
                                    </div>
                                )}
                            </div>
                            <div className="mt-4">
                                <ProductSummary product={project.product} large />
                            </div>
                            {project.product.material ? (
                                <div className="mt-4 rounded-xl bg-muted/40 p-3 text-xs leading-5">
                                    <div className="mb-1 font-medium">材质</div>
                                    {project.product.material}
                                </div>
                            ) : null}
                            {project.product.sellingPoints.length ? (
                                <div className="mt-4">
                                    <div className="mb-2 text-xs font-medium text-muted-foreground">商品卖点</div>
                                    <div className="flex flex-wrap gap-1">
                                        {project.product.sellingPoints.map((point) => (
                                            <Tag key={point} className="m-0">
                                                {point}
                                            </Tag>
                                        ))}
                                    </div>
                                </div>
                            ) : null}
                            <div className="mt-5 border-t border-border pt-4 text-xs text-muted-foreground">商品资料在每次生成时读取最新值；四视角主图固定为项目创建时的版本。</div>
                        </div>
                    </aside>
                    <main className="min-w-0">
                        <div className="mb-3 flex items-end justify-between gap-3">
                            <div>
                                <h2 className="text-lg font-semibold">参考图 / 生成图 / 修改图</h2>
                                <p className="mt-1 text-xs text-muted-foreground">
                                    共 {project.pairs.length} 组，一对一生成；已完成 {completed} 组。
                                </p>
                            </div>
                            <div className="text-xs text-muted-foreground">项目 revision {project.revision}</div>
                        </div>
                        <div className="grid min-w-[840px] grid-cols-[repeat(3,minmax(260px,1fr))] gap-4 overflow-x-auto">
                            <div className="border-b-2 border-foreground/15 pb-2 text-sm font-medium">参考图</div>
                            <div className="border-b-2 border-foreground/15 pb-2 text-sm font-medium">生成图</div>
                            <div className="border-b-2 border-foreground/15 pb-2 text-sm font-medium">修改图</div>
                            {project.pairs.map((pair, index) => (
                                <PairRow
                                    key={pair.id}
                                    pair={pair}
                                    index={index}
                                    canEdit={canEdit}
                                    onGenerate={() => onGenerate(pair)}
                                    onRetryFromResult={() => onRetryFromResult(pair)}
                                    onCancel={() => onCancel(pair)}
                                    onOpenPrompt={() => onOpenPrompt(pair)}
                                    onResetPrompt={() => onResetPrompt(pair)}
                                    onDownload={() => onDownloadPair(pair)}
                                    onLocalEdit={() => onLocalEdit(pair)}
                                    onPromoteVariant={(variant) => onPromoteVariant(pair, variant)}
                                    onDeleteVariant={(variant) => onDeleteVariant(pair, variant)}
                                    onCancelVariant={(variant) => onCancelVariant(pair, variant)}
                                    onSelectVariant={(variantId) => onSelectVariant(pair.id, variantId)}
                                    selectedVariantId={selectedVariantIds[pair.id]}
                                    personalRunning={personalRunning.has(pair.id)}
                                />
                            ))}
                        </div>
                    </main>
                </div>
            </div>
        </div>
    );
}

function PairRow({
    pair,
    index,
    canEdit,
    onGenerate,
    onRetryFromResult,
    onCancel,
    onOpenPrompt,
    onResetPrompt,
    onDownload,
    onLocalEdit,
    onPromoteVariant,
    onDeleteVariant,
    onCancelVariant,
    onSelectVariant,
    selectedVariantId,
    personalRunning,
}: {
    pair: DetailPagePair;
    index: number;
    canEdit: boolean;
    onGenerate: () => void;
    onRetryFromResult: () => void;
    onCancel: () => void;
    onOpenPrompt: () => void;
    onResetPrompt: () => void;
    onDownload: () => void;
    onLocalEdit: () => void;
    onPromoteVariant: (variant: DetailPagePairVariant) => void;
    onDeleteVariant: (variant: DetailPagePairVariant) => void;
    onCancelVariant: (variant: DetailPagePairVariant) => void;
    onSelectVariant: (variantId: string) => void;
    selectedVariantId?: string;
    personalRunning: boolean;
}) {
    const ratio = referenceRatio(pair);
    const variants = pair.modificationVariants || [];
    const busy = personalRunning || pair.status === "queued" || pair.status === "running" || variants.some((variant) => variant.status === "queued" || variant.status === "running");
    const selectedVariant = variants.find((variant) => variant.id === selectedVariantId) || variants[0];
    const isCurrentVariant = selectedVariant ? variants[0]?.id === selectedVariant.id : false;
    const variantBusy = selectedVariant && (selectedVariant.status === "queued" || selectedVariant.status === "running");
    const mediaBox = (media: DetailPageMedia | undefined, label: string) => (
        <div className="relative block w-full overflow-hidden rounded-xl border border-border bg-muted" style={{ aspectRatio: ratio }}>
            {media?.url ? (
                <Image
                    rootClassName="!block !h-full !w-full"
                    src={media.thumbnailUrl || media.url}
                    alt={label}
                    preview={{ src: media.url, mask: "查看原图" }}
                    className="!block !h-full !w-full [&_.ant-image-img]:!h-full [&_.ant-image-img]:!w-full [&_.ant-image-img]:!object-contain"
                />
            ) : (
                <div className="grid size-full place-items-center text-xs text-muted-foreground">图片不可用</div>
            )}
        </div>
    );
    return (
        <>
            <div className="min-w-0 rounded-2xl border border-border bg-card p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-muted-foreground">参考 {index + 1}</span>
                    <span className="text-[11px] text-muted-foreground">
                        {pair.referenceWidth} × {pair.referenceHeight}
                    </span>
                </div>
                {mediaBox(pair.referenceImage, `参考图 ${index + 1}`)}
            </div>
            <div className="min-w-0 rounded-2xl border border-border bg-card p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                    <Tag color={pairTagColor(pair.status)} className="m-0">
                        {pairStatusText(pair.status)}
                    </Tag>
                    <span className="text-xs text-muted-foreground">第 {index + 1} 张</span>
                </div>
                {pair.resultImage?.url ? (
                    mediaBox(pair.resultImage, `生成图 ${index + 1}`)
                ) : (
                    <div className="relative flex w-full flex-col items-center justify-center gap-2 rounded-xl border border-border bg-muted p-4 text-center text-sm text-muted-foreground" style={{ aspectRatio: ratio }}>
                        {busy ? <LoaderCircle className="size-7 animate-spin" /> : pair.status === "failed" || pair.status === "interrupted" ? <RefreshCw className="size-7 text-red-500/70" /> : <Sparkles className="size-7 opacity-40" />}
                        <span>{busy ? (pair.status === "queued" ? "等待任务开始" : "正在生成") : pair.error || "等待生成"}</span>
                    </div>
                )}
                {pair.error ? <div className="mt-2 line-clamp-3 rounded-lg bg-red-500/5 px-2.5 py-2 text-xs leading-5 text-red-600">{pair.error}</div> : null}
                <div className="mt-3 flex flex-wrap items-center gap-1">
                    <Button type="text" size="small" icon={<RefreshCw className="size-3.5" />} disabled={!canEdit || busy} onClick={onGenerate}>
                        {pair.resultImage ? "重试" : "生成"}
                    </Button>
                    {pair.resultImage ? (
                        <Button type="text" size="small" disabled={!canEdit || busy} onClick={onRetryFromResult}>
                            按生成图重试
                        </Button>
                    ) : null}
                    {pair.activeTaskId && pair.status === "queued" ? (
                        <Button type="text" size="small" danger disabled={!canEdit} onClick={onCancel}>
                            取消
                        </Button>
                    ) : null}
                    <Button type="text" size="small" icon={<Pencil className="size-3.5" />} disabled={!canEdit || busy} onClick={onOpenPrompt}>
                        提示词
                    </Button>
                    <Button type="text" size="small" disabled={!canEdit || busy} onClick={onResetPrompt}>
                        重置
                    </Button>
                    <Button type="text" size="small" disabled={!canEdit || busy || !pair.resultImage} onClick={onLocalEdit}>
                        局部编辑
                    </Button>
                    {pair.resultImage ? (
                        <Button type="text" size="small" icon={<Download className="size-3.5" />} onClick={onDownload}>
                            下载
                        </Button>
                    ) : null}
                </div>
            </div>
            <div className="min-w-0 rounded-2xl border border-border bg-card p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-muted-foreground">修改候选</span>
                    {variants.length ? (
                        <Select
                            size="small"
                            className="min-w-0 flex-1"
                            value={selectedVariant?.id}
                            onChange={onSelectVariant}
                            options={variants.map((variant) => ({
                                value: variant.id,
                                label: `${variant.kind === "mask_edit" ? "局部编辑" : variant.kind === "previous_main" ? "原正式图" : variant.kind === "result_retry" ? "按生成图重试" : "重试"} · ${new Date(variant.createdAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })} · ${variant.prompt.slice(0, 24)}`,
                            }))}
                        />
                    ) : null}
                </div>
                {selectedVariant?.image?.url ? (
                    mediaBox(selectedVariant.image, "修改图")
                ) : (
                    <div className="flex w-full flex-col items-center justify-center gap-2 rounded-xl border border-border bg-muted p-4 text-center text-sm text-muted-foreground" style={{ aspectRatio: ratio }}>
                        {variantBusy ? <LoaderCircle className="size-7 animate-spin" /> : selectedVariant?.error || "暂无修改图"}
                    </div>
                )}
                {selectedVariant?.prompt ? <div className="mt-2 line-clamp-2 text-xs text-muted-foreground">{selectedVariant.prompt.slice(0, 80)}</div> : null}
                <div className="mt-3 flex flex-wrap items-center gap-1">
                    {selectedVariant?.status === "queued" && selectedVariant.activeTaskId ? (
                        <Button type="text" size="small" danger disabled={!canEdit} onClick={() => onCancelVariant(selectedVariant)}>
                            取消排队
                        </Button>
                    ) : null}
                    {selectedVariant?.status === "succeeded" && selectedVariant.image ? (
                        <Button type="primary" size="small" disabled={!canEdit} onClick={() => onPromoteVariant(selectedVariant)}>
                            覆盖
                        </Button>
                    ) : null}
                    {selectedVariant && selectedVariant.status !== "queued" && selectedVariant.status !== "running" ? (
                        <Button type="text" size="small" danger disabled={!canEdit || (isCurrentVariant && selectedVariant.status === "succeeded")} icon={<Trash2 className="size-3.5" />} onClick={() => onDeleteVariant(selectedVariant)}>
                            删除历史
                        </Button>
                    ) : null}
                </div>
            </div>
        </>
    );
}

function loadImage(url: string) {
    return new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new window.Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("读取生成图失败"));
        image.src = url;
    });
}

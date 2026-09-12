import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { App, Button, Checkbox, Image, Input, Modal, Spin } from "antd";
import { ArrowDown, ArrowUp, ImagePlus, ShieldCheck, Trash2, Upload } from "lucide-react";

import { canvasThemes } from "@/lib/canvas-theme";
import type { CompetitorReplicationDialogValue } from "@/lib/canvas/competitor-visual-replication";
import { uploadImage, type UploadedImage } from "@/services/image-storage";
import { useThemeStore } from "@/stores/use-theme-store";

const MAX_IMAGES = 3;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export function CanvasCompetitorReplicationDialog({
    open,
    sourceNodeId,
    sourceImageUrl,
    ownerId,
    onClose,
    onConfirm,
}: {
    open: boolean;
    sourceNodeId: string;
    sourceImageUrl: string;
    ownerId: string;
    onClose: () => void;
    onConfirm: (value: CompetitorReplicationDialogValue) => Promise<void>;
}) {
    const { message } = App.useApp();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const inputRef = useRef<HTMLInputElement>(null);
    const [images, setImages] = useState<UploadedImage[]>([]);
    const [instruction, setInstruction] = useState("");
    const [includeBrand, setIncludeBrand] = useState(false);
    const [brandOverride, setBrandOverride] = useState("");
    const [includeText, setIncludeText] = useState(false);
    const [textOverride, setTextOverride] = useState("");
    const [includePackaging, setIncludePackaging] = useState(false);
    const [uploading, setUploading] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [dragging, setDragging] = useState(false);

    useEffect(() => {
        if (!open) return;
        setImages([]);
        setInstruction("");
        setIncludeBrand(false);
        setBrandOverride("");
        setIncludeText(false);
        setTextOverride("");
        setIncludePackaging(false);
        setUploading(false);
        setSubmitting(false);
        setDragging(false);
    }, [open, sourceNodeId]);

    const addFiles = async (files: FileList | File[]) => {
        const available = MAX_IMAGES - images.length;
        const allFiles = Array.from(files);
        if (allFiles.some((file) => !file.type.startsWith("image/"))) message.warning("竞品参考只支持图片文件");
        if (allFiles.filter((file) => file.type.startsWith("image/")).length > available) message.warning(`最多上传 ${MAX_IMAGES} 张竞品参考图`);
        const selected = allFiles.filter((file) => file.type.startsWith("image/")).slice(0, available);
        if (!selected.length) {
            message.warning(available ? "请选择图片文件" : `最多上传 ${MAX_IMAGES} 张竞品参考图`);
            return;
        }
        if (Array.from(files).some((file) => file.size > MAX_IMAGE_BYTES)) message.warning("单张竞品图片不能超过 20MB");
        setUploading(true);
        try {
            const results = await Promise.allSettled(selected.filter((file) => file.size <= MAX_IMAGE_BYTES).map((file) => uploadImage(file, ownerId)));
            const uploaded = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
            setImages((current) => [...current, ...uploaded].slice(0, MAX_IMAGES));
            const failed = results.find((result) => result.status === "rejected");
            if (failed?.status === "rejected") message.error(failed.reason instanceof Error ? failed.reason.message : "部分竞品图片上传失败");
        } finally {
            setUploading(false);
            if (inputRef.current) inputRef.current.value = "";
        }
    };

    const move = (index: number, offset: number) => {
        setImages((current) => {
            const target = index + offset;
            if (target < 0 || target >= current.length) return current;
            const next = [...current];
            [next[index], next[target]] = [next[target], next[index]];
            return next;
        });
    };

    return (
        <Modal title={null} open={open} onCancel={onClose} footer={null} width={900} centered destroyOnHidden>
            <div className="space-y-5" style={{ color: theme.node.text }}>
                <div>
                    <h2 className="text-xl font-semibold">竞品视觉复刻</h2>
                    <p className="mt-1 text-sm" style={{ color: theme.node.muted }}>保留自己的商品，只迁移竞品的构图、色彩、光线、镜头和氛围。</p>
                </div>

                <div className="grid gap-5 md:grid-cols-[240px_minmax(0,1fr)]">
                    <section>
                        <div className="mb-2 text-sm font-medium">我的商品</div>
                        <div className="overflow-hidden rounded-xl border" style={{ borderColor: theme.node.stroke, background: theme.canvas.background }}>
                            <Image src={sourceImageUrl} alt="我的商品" className="!aspect-square !w-full !object-contain" preview={{ mask: "预览" }} />
                        </div>
                    </section>

                    <section>
                        <div className="mb-2 flex items-center justify-between gap-3">
                            <div className="text-sm font-medium">竞品参考图</div>
                            <span className="text-xs" style={{ color: theme.node.muted }}>{images.length}/{MAX_IMAGES}</span>
                        </div>
                        <button
                            type="button"
                            className="flex min-h-32 w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed px-5 py-6 text-center transition hover:opacity-80"
                            style={{ borderColor: dragging ? theme.node.activeStroke : theme.node.stroke, background: dragging ? theme.toolbar.activeBg : "transparent", color: theme.node.muted }}
                            disabled={uploading || images.length >= MAX_IMAGES}
                            onClick={() => inputRef.current?.click()}
                            onDragOver={(event) => {
                                event.preventDefault();
                                if (!uploading && images.length < MAX_IMAGES) setDragging(true);
                            }}
                            onDragLeave={() => setDragging(false)}
                            onDrop={(event) => {
                                event.preventDefault();
                                setDragging(false);
                                if (!uploading && images.length < MAX_IMAGES) void addFiles(event.dataTransfer.files);
                            }}
                        >
                            {uploading ? <Spin size="small" /> : <Upload className="size-6" />}
                            <span className="text-sm font-medium">{uploading ? "正在上传竞品图片…" : "点击或拖入 1–3 张竞品参考图"}</span>
                            <span className="text-xs opacity-70">支持常见图片格式，单张不超过 20MB</span>
                        </button>
                        <input ref={inputRef} type="file" accept="image/*" multiple className="hidden" onChange={(event) => void addFiles(event.target.files || [])} />

                        {images.length ? (
                            <Image.PreviewGroup>
                                <div className="mt-3 grid grid-cols-3 gap-3">
                                    {images.map((image, index) => (
                                        <div key={image.storageKey} className="group relative overflow-hidden rounded-lg border" style={{ borderColor: theme.node.stroke, background: theme.canvas.background }}>
                                            <Image src={image.thumbnailUrl} alt={`竞品参考 ${index + 1}`} className="!aspect-square !w-full !object-cover" preview={{ src: image.url, mask: "预览" }} />
                                            <div className="flex items-center justify-between gap-1 px-2 py-1.5">
                                                <span className="text-xs font-medium">竞品 {index + 1}</span>
                                                <div className="flex items-center">
                                                    <IconButton label="前移" disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp className="size-3.5" /></IconButton>
                                                    <IconButton label="后移" disabled={index === images.length - 1} onClick={() => move(index, 1)}><ArrowDown className="size-3.5" /></IconButton>
                                                    <IconButton label="删除" onClick={() => setImages((current) => current.filter((_, itemIndex) => itemIndex !== index))}><Trash2 className="size-3.5 text-red-400" /></IconButton>
                                                </div>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </Image.PreviewGroup>
                        ) : null}
                    </section>
                </div>

                <div>
                    <div className="mb-2 text-sm font-medium">复刻内容 <span className="font-normal opacity-50">默认不复刻</span></div>
                    <div className="space-y-3 rounded-xl border p-3" style={{ borderColor: theme.node.stroke, background: theme.canvas.background }}>
                        <div>
                            <Checkbox checked={includeBrand} onChange={(event) => setIncludeBrand(event.target.checked)}>复刻竞品品牌 / Logo</Checkbox>
                            {includeBrand ? <Input value={brandOverride} maxLength={100} showCount className="mt-2" placeholder="指定品牌（可选），留空则保留竞品图中清晰可见的原品牌" onChange={(event) => setBrandOverride(event.target.value)} /> : null}
                        </div>
                        <div>
                            <Checkbox checked={includeText} onChange={(event) => setIncludeText(event.target.checked)}>复刻竞品文字</Checkbox>
                            {includeText ? <Input value={textOverride} maxLength={300} showCount className="mt-2" placeholder="指定文字（可选），留空则保留竞品图中清晰可识别的原文字" onChange={(event) => setTextOverride(event.target.value)} /> : null}
                        </div>
                        <Checkbox checked={includePackaging} onChange={(event) => setIncludePackaging(event.target.checked)}>复刻竞品包装与装饰</Checkbox>
                    </div>
                </div>

                <div>
                    <div className="mb-2 text-sm font-medium">补充要求 <span className="font-normal opacity-50">可选</span></div>
                    <Input.TextArea value={instruction} maxLength={500} showCount autoSize={{ minRows: 3, maxRows: 6 }} placeholder="例如：保留红色高对比风格，突出产品主体，不要复杂背景。" onChange={(event) => setInstruction(event.target.value)} />
                </div>

                <div className="flex gap-3 rounded-xl border p-3 text-xs leading-5" style={{ borderColor: theme.node.stroke, background: theme.toolbar.activeBg, color: theme.node.muted }}>
                    <ShieldCheck className="mt-0.5 size-4 shrink-0" />
                    <span>{replicationNotice({ includeBrand, includeText, includePackaging })} 仅在你拥有相应使用权时开启复刻；人物、模特脸和水印始终不会复刻。系统会先进行视觉分析，分析失败时不会继续生成图片。</span>
                </div>

                <div className="flex justify-end gap-2">
                    <Button onClick={onClose}>取消</Button>
                    <Button
                        type="primary"
                        icon={<ImagePlus className="size-4" />}
                        loading={submitting}
                        disabled={!images.length || uploading}
                        onClick={async () => {
                            setSubmitting(true);
                            try {
                                await onConfirm({
                                    sourceNodeId,
                                    competitorMediaIds: images.map((image) => image.storageKey.slice("media:".length)),
                                    competitorImages: images,
                                    instruction: instruction.trim(),
                                    includeBrand,
                                    brandOverride: includeBrand ? brandOverride.trim() : "",
                                    includeText,
                                    textOverride: includeText ? textOverride.trim() : "",
                                    includePackaging,
                                });
                            } finally {
                                setSubmitting(false);
                            }
                        }}
                    >
                        开始复刻
                    </Button>
                </div>
            </div>
        </Modal>
    );
}

function replicationNotice({ includeBrand, includeText, includePackaging }: { includeBrand: boolean; includeText: boolean; includePackaging: boolean }) {
    const enabled = [
        includeBrand ? "品牌 / Logo" : "",
        includeText ? "文字" : "",
        includePackaging ? "包装与装饰" : "",
    ].filter(Boolean);
    return enabled.length ? `将复刻竞品的${enabled.join("、")}；未选择的内容不会复刻。` : "仅迁移竞品的视觉策略，不复刻竞品品牌、Logo、文字、包装或装饰。";
}

function IconButton({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick: () => void; children: ReactNode }) {
    return (
        <button type="button" title={label} aria-label={label} disabled={disabled} className="grid size-7 place-items-center rounded-md transition hover:bg-black/5 disabled:opacity-25 dark:hover:bg-white/10" onClick={onClick}>
            {children}
        </button>
    );
}

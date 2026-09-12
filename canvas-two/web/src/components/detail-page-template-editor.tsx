import { ChevronLeft, ChevronRight, GripVertical, ImagePlus, Upload, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { App, Button, Input, Modal } from "antd";

import { uploadImage } from "@/services/image-storage";
import { createDetailPageTemplate, updateDetailPageTemplate } from "@/services/detail-page-templates";
import type { DetailPageMedia, DetailPageTemplate } from "@/types/detail-page";

const MAX_REFERENCES = 18;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

function errorText(error: unknown) {
    return error instanceof Error && error.message.trim() ? error.message.trim() : "请求失败，请稍后重试";
}

function moveItem<T>(items: T[], index: number, offset: number) {
    const target = index + offset;
    if (target < 0 || target >= items.length) return items;
    const next = [...items];
    [next[index], next[target]] = [next[target], next[index]];
    return next;
}

function reorderItem<T>(items: T[], from: number, to: number) {
    if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) return items;
    const next = [...items];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    return next;
}

export function DetailPageTemplateEditor({ open, template, ownerId, canEdit, onClose, onSaved }: { open: boolean; template: DetailPageTemplate | null; ownerId: string; canEdit: boolean; onClose: () => void; onSaved: (template: DetailPageTemplate) => void }) {
    const { message } = App.useApp();
    const fileInputRef = useRef<HTMLInputElement>(null);
    const draggedIndexRef = useRef(-1);
    const [name, setName] = useState("");
    const [references, setReferences] = useState<DetailPageMedia[]>([]);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (!open) return;
        setName(template?.name || "");
        setReferences(template?.references.map((reference) => reference.image) || []);
        draggedIndexRef.current = -1;
    }, [open, template]);

    const addFiles = async (files: FileList | null) => {
        const incoming = Array.from(files || []);
        if (references.length >= MAX_REFERENCES) return message.warning(`最多上传 ${MAX_REFERENCES} 张参考图`);
        const accepted = incoming.filter((file) => {
            if (!file.type.startsWith("image/")) { message.warning(`「${file.name}」不是图片文件`); return false; }
            if (file.size > MAX_IMAGE_BYTES) { message.warning(`「${file.name}」超过 20MB，无法上传`); return false; }
            return true;
        });
        for (const file of accepted.slice(0, MAX_REFERENCES - references.length)) {
            try {
                const uploaded = await uploadImage(file, ownerId);
                if (uploaded.width && uploaded.height && Math.max(uploaded.width / uploaded.height, uploaded.height / uploaded.width) > 3) { message.warning(`「${file.name}」宽高比超过 3:1，请拆分成长图后再上传`); continue; }
                const mediaId = uploaded.storageKey.replace(/^media:/, "");
                setReferences((current) => [...current, { id: mediaId, mediaId, fileName: file.name, mimeType: uploaded.mimeType, bytes: uploaded.bytes, url: uploaded.url, thumbnailUrl: uploaded.thumbnailUrl, storageKey: uploaded.storageKey, width: uploaded.width, height: uploaded.height }].slice(0, MAX_REFERENCES));
            } catch (error) { message.error(errorText(error)); }
        }
        if (incoming.length + references.length > MAX_REFERENCES) message.warning(`最多保留 ${MAX_REFERENCES} 张参考图`);
    };

    const save = async () => {
        if (!canEdit) return message.warning("你没有编辑详情页模板的权限");
        if (!name.trim()) return message.warning("请输入模板名称");
        if (!references.length) return message.warning("请至少添加 1 张参考图");
        setSaving(true);
        try {
            const referenceMediaIds = references.map((reference) => reference.mediaId);
            const saved = template
                ? await updateDetailPageTemplate(template.id, { revision: template.revision, name: name.trim(), referenceMediaIds })
                : await createDetailPageTemplate({ ownerId, name: name.trim(), referenceMediaIds });
            message.success(template ? "模板已保存" : "模板已创建");
            onSaved(saved);
        } catch (error) { message.error(errorText(error)); }
        finally { setSaving(false); }
    };

    return <Modal open={open} width={900} title={template ? "编辑详情页模板" : "新建详情页模板"} destroyOnHidden onCancel={onClose} footer={[<Button key="cancel" onClick={onClose}>取消</Button>, <Button key="save" type="primary" loading={saving} disabled={!canEdit || !references.length || !name.trim()} onClick={() => void save()}>保存模板</Button>]}><div className="space-y-5"><div><div className="mb-2 text-sm font-medium">模板名称</div><Input value={name} maxLength={120} showCount onChange={(event) => setName(event.target.value)} placeholder="例如：女鞋详情页参考模板" /></div><div><div className="mb-2 flex items-center justify-between text-sm font-medium"><span>参考详情页图片（{references.length}/{MAX_REFERENCES}）</span><Button type="text" size="small" icon={<Upload className="size-4" />} disabled={references.length >= MAX_REFERENCES} onClick={() => fileInputRef.current?.click()}>上传图片</Button></div><p className="mb-3 text-xs leading-5 text-muted-foreground">第一张图片会作为模板缩略图；可拖动调整顺序，支持 1–18 张，单张不超过 20MB，宽高比不能超过 3:1。</p><input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden" onChange={(event) => { void addFiles(event.target.files); event.target.value = ""; }} /><div className="grid grid-cols-3 gap-3 sm:grid-cols-6">{references.map((image, index) => <div key={image.mediaId} draggable className="group relative cursor-grab overflow-hidden rounded-xl border border-border bg-muted active:cursor-grabbing" style={{ aspectRatio: `${image.width || 2} / ${image.height || 3}` }} onDragStart={() => { draggedIndexRef.current = index; }} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); setReferences((current) => reorderItem(current, draggedIndexRef.current, index)); draggedIndexRef.current = -1; }} onDragEnd={() => { draggedIndexRef.current = -1; }}><img src={image.thumbnailUrl || image.url} alt={image.fileName} className="size-full object-contain" /><div className="absolute left-1 top-1 flex items-center gap-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white"><GripVertical className="size-3" />{index + 1}{index === 0 ? " · 缩略图" : ""}</div><button type="button" aria-label={`删除第 ${index + 1} 张参考图`} className="absolute right-1 top-1 grid size-6 place-items-center rounded-full bg-black/60 text-white opacity-0 transition group-hover:opacity-100" onClick={() => setReferences((current) => current.filter((item) => item.mediaId !== image.mediaId))}><X className="size-3.5" /></button><div className="absolute inset-x-1 bottom-1 flex justify-between opacity-0 transition group-hover:opacity-100"><button type="button" aria-label="向前移动" disabled={index === 0} className="grid size-6 place-items-center rounded bg-black/60 text-white disabled:opacity-30" onClick={() => setReferences((current) => moveItem(current, index, -1))}><ChevronLeft className="size-3.5" /></button><button type="button" aria-label="向后移动" disabled={index === references.length - 1} className="grid size-6 place-items-center rounded bg-black/60 text-white disabled:opacity-30" onClick={() => setReferences((current) => moveItem(current, index, 1))}><ChevronRight className="size-3.5" /></button></div></div>)}{references.length < MAX_REFERENCES ? <button type="button" className="flex min-h-28 flex-col items-center justify-center rounded-xl border border-dashed border-border text-xs text-muted-foreground transition hover:border-primary hover:text-primary" onClick={() => fileInputRef.current?.click()}><ImagePlus className="mb-2 size-5" />添加参考图</button> : null}</div></div></div></Modal>;
}

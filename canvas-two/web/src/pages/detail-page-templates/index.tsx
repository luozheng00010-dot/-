import { Eye, FileImage, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { App, Button, Empty, Image, Input, Modal, Pagination, Spin, Tag } from "antd";

import { DetailPageTemplateEditor } from "@/components/detail-page-template-editor";
import { OwnerScopePicker } from "@/components/layout/owner-scope-picker";
import { deleteDetailPageTemplate, listDetailPageTemplates } from "@/services/detail-page-templates";
import { currentAccessLevel, selectedOwnerId, useOwnerScopeStore } from "@/stores/use-owner-scope-store";
import type { DetailPageTemplate } from "@/types/detail-page";

const PAGE_SIZE = 24;

function errorText(error: unknown) {
    return error instanceof Error && error.message.trim() ? error.message.trim() : "请求失败，请稍后重试";
}

export default function DetailPageTemplatesPage() {
    const { message, modal } = App.useApp();
    const scope = useOwnerScopeStore((state) => state.scope);
    const [templates, setTemplates] = useState<DetailPageTemplate[]>([]);
    const [total, setTotal] = useState(0);
    const [page, setPage] = useState(1);
    const [keyword, setKeyword] = useState("");
    const [searchKeyword, setSearchKeyword] = useState("");
    const [loading, setLoading] = useState(false);
    const [editorOpen, setEditorOpen] = useState(false);
    const [editing, setEditing] = useState<DetailPageTemplate | null>(null);
    const [previewing, setPreviewing] = useState<DetailPageTemplate | null>(null);

    const load = () => {
        setLoading(true);
        void listDetailPageTemplates({ owner: scope, keyword: searchKeyword, page, pageSize: PAGE_SIZE }).then((result) => { setTemplates(result.items); setTotal(result.total); }).catch((error) => message.error(errorText(error))).finally(() => setLoading(false));
    };

    useEffect(() => {
        const timer = window.setTimeout(() => { setPage(1); setSearchKeyword(keyword.trim()); }, 300);
        return () => window.clearTimeout(timer);
    }, [keyword]);

    useEffect(() => { load(); }, [page, scope, searchKeyword]);

    const openCreate = () => { setEditing(null); setEditorOpen(true); };
    const openEdit = (template: DetailPageTemplate) => { setEditing(template); setEditorOpen(true); };
    const remove = (template: DetailPageTemplate) => {
        modal.confirm({ title: `删除「${template.name}」？`, content: "只删除模板关系，不删除参考图媒体文件和已有详情页项目。", okText: "删除", okButtonProps: { danger: true }, cancelText: "取消", onOk: async () => { try { await deleteDetailPageTemplate(template.id, template.revision); message.success("模板已删除"); load(); } catch (error) { message.error(errorText(error)); } } });
    };

    const canCreate = currentAccessLevel() === "edit";
    return <div className="h-full overflow-y-auto bg-background text-foreground"><div className="mx-auto max-w-[1500px] px-6 py-8"><div className="flex flex-wrap items-end justify-between gap-4"><div><div className="flex items-center gap-3"><div className="grid size-10 place-items-center rounded-2xl bg-foreground text-background"><FileImage className="size-5" /></div><div><h1 className="text-3xl font-semibold tracking-tight">详情页模板</h1><p className="mt-1 text-sm text-muted-foreground">保存常用详情页参考图组合，新建复刻项目时一键套用。</p></div></div></div><OwnerScopePicker /></div><div className="mt-8 flex flex-wrap items-center justify-between gap-3"><Input className="w-full max-w-sm" value={keyword} onChange={(event) => setKeyword(event.target.value)} allowClear prefix={<Search className="size-4 text-muted-foreground" />} placeholder="搜索模板名称" /><Button type="primary" icon={<Plus className="size-4" />} disabled={!canCreate} onClick={openCreate}>新建详情页模板</Button></div>{loading && !templates.length ? <div className="grid min-h-64 place-items-center"><Spin /></div> : null}{!loading && !templates.length ? <Empty className="py-24" image={<FileImage className="mx-auto size-12 text-muted-foreground" />} description={searchKeyword ? "没有找到匹配的模板" : "还没有详情页模板"} /> : null}{templates.length ? <><div className="mt-6 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">{templates.map((template) => <TemplateCard key={template.id} template={template} onPreview={() => setPreviewing(template)} onEdit={() => openEdit(template)} onDelete={() => remove(template)} />)}</div>{total > PAGE_SIZE ? <div className="mt-8 flex justify-center"><Pagination current={page} pageSize={PAGE_SIZE} total={total} showSizeChanger={false} onChange={setPage} /></div> : null}</> : null}</div><DetailPageTemplateEditor open={editorOpen} template={editing} ownerId={selectedOwnerId()} canEdit={canCreate} onClose={() => setEditorOpen(false)} onSaved={() => { setEditorOpen(false); load(); }} /><Modal open={Boolean(previewing)} width={960} title={previewing?.name || "模板预览"} footer={null} onCancel={() => setPreviewing(null)}><p className="mb-4 text-sm text-muted-foreground">共 {previewing?.referenceCount || 0} 张参考图，第一张为模板缩略图。</p><div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">{previewing?.references.map((reference, index) => <div key={reference.id} className="overflow-hidden rounded-xl border border-border bg-muted"><div className="relative aspect-[2/3]"><Image rootClassName="!block !h-full !w-full" src={reference.image.thumbnailUrl || reference.image.url} preview={{ src: reference.image.url, mask: "查看原图" }} className="!block !h-full !w-full [&_.ant-image-img]:!h-full [&_.ant-image-img]:!w-full [&_.ant-image-img]:!object-contain" /><span className="absolute left-2 top-2 rounded bg-black/60 px-2 py-0.5 text-[11px] text-white">{index + 1}{index === 0 ? " · 缩略图" : ""}</span></div></div>)}</div></Modal></div>;
}

function TemplateCard({ template, onPreview, onEdit, onDelete }: { template: DetailPageTemplate; onPreview: () => void; onEdit: () => void; onDelete: () => void }) {
    const canEdit = template.accessLevel === "edit";
    return <div className="group overflow-hidden rounded-2xl border border-border bg-card"><div className="relative aspect-[4/3] overflow-hidden bg-muted">{template.coverImage?.url ? <Image rootClassName="!block !h-full !w-full" src={template.coverImage.thumbnailUrl || template.coverImage.url} preview={{ src: template.coverImage.url, mask: "查看原图" }} className="!block !h-full !w-full [&_.ant-image-img]:!h-full [&_.ant-image-img]:!w-full [&_.ant-image-img]:!object-contain" /> : <div className="grid size-full place-items-center text-muted-foreground"><FileImage className="size-9" /></div>}<Tag className="absolute left-3 top-3">{template.referenceCount} 张参考图</Tag></div><div className="space-y-3 p-4"><div className="truncate font-medium">{template.name}</div><div className="text-xs text-muted-foreground">{template.ownerUsername} · 更新于 {new Date(template.updatedAt).toLocaleDateString("zh-CN")}</div><div className="flex items-center gap-1"><Button type="text" size="small" icon={<Eye className="size-3.5" />} onClick={onPreview}>预览</Button><Button type="text" size="small" icon={<Pencil className="size-3.5" />} disabled={!canEdit} onClick={onEdit}>编辑</Button><Button type="text" size="small" danger icon={<Trash2 className="size-3.5" />} disabled={!canEdit} onClick={onDelete}>删除</Button></div></div></div>;
}

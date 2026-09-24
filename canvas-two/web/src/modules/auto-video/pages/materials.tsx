import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Alert, App, Button, Input, Modal, Popconfirm, Select, Space, Table, Upload } from "antd";
import { Clapperboard, FolderOpen, RefreshCw, ScanSearch, Upload as UploadIcon } from "lucide-react";
import { assignLocalVideo, deleteLibraryOption, deleteLocalVideo, deleteLocalVideosBySku, listLibraryOptions, listLocalVideos, localVideoUrl, saveLibraryOption, uploadLocalVideo, type LibraryKind, type LibraryOption, type LocalVideo } from "@/services/local-materials";

import { analyzeMaterials, annotateMaterial, materialIndexStatus } from "@/services/local-materials";
import { Field, FormSection } from "@/components/ui/form-section";
import { PageHeader } from "@/components/ui/page-header";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import MaterialAnnotationEditor from "./material-annotation";

type UploadItem = { id: string; file: File; status: "待上传" | "上传中" | "成功" | "失败"; error?: string };
const optionItems = (items: LibraryOption[]) => items.map((item) => ({ label: item.name, value: item.id }));
const STATUS_LABELS: Record<string, string> = { pending: "待分析", queued: "分析排队中", indexing: "索引中", ready: "可匹配", review: "待人工确认", failed: "处理失败" };
const STATUS_TONES: Record<string, StatusTone> = { pending: "muted", queued: "processing", indexing: "processing", ready: "success", review: "warning", failed: "error" };
const AMBER_TONE = "bg-amber-500/10 text-amber-600 dark:text-amber-400";

export default function AutoVideoMaterials() {
    const { message } = App.useApp();
    const [skus, setSkus] = useState<LibraryOption[]>([]);
    const [categories, setCategories] = useState<LibraryOption[]>([]);
    const [skuFilter, setSkuFilter] = useState<string>();
    const [categoryFilter, setCategoryFilter] = useState<string>();
    const [statusFilter, setStatusFilter] = useState<string>();
    const [page, setPage] = useState(1);
    const [revision, setRevision] = useState(0);
    const [rows, setRows] = useState<LocalVideo[]>([]);
    const [selected, setSelected] = useState<string[]>([]);
    const [annotationEditor, setAnnotationEditor] = useState<LocalVideo>();
    const [indexStatus, setIndexStatus] = useState<{ total: number; ready: number; configured: boolean }>();
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(false);
    const [preview, setPreview] = useState<LocalVideo>();
    const [manager, setManager] = useState<LibraryKind>();
    const [nameEditor, setNameEditor] = useState<{ kind: LibraryKind; id?: string; name: string }>();
    const [saving, setSaving] = useState(false);
    const [uploadOpen, setUploadOpen] = useState(false);
    const [uploadSku, setUploadSku] = useState<string>();
    const [uploadCategory, setUploadCategory] = useState<string>();
    const [uploadNotes, setUploadNotes] = useState("");
    const [files, setFiles] = useState<UploadItem[]>([]);
    const [uploading, setUploading] = useState(false);
    const uploadLock = useRef(false);
    const [editing, setEditing] = useState<LocalVideo>();
    const [editSku, setEditSku] = useState<string>();
    const [editCategory, setEditCategory] = useState<string>();
    const [purgeTarget, setPurgeTarget] = useState<string>();
    const report = useCallback((error: unknown) => { message.error(error instanceof Error ? error.message : "操作失败"); }, [message]);
    const refreshOptions = useCallback(async () => {
        const [nextSkus, nextCategories] = await Promise.all([listLibraryOptions("skus"), listLibraryOptions("categories")]);
        setSkus(nextSkus); setCategories(nextCategories);
    }, []);
    useEffect(() => { void refreshOptions().catch(report); }, [refreshOptions, report]);
    useEffect(() => {
        const controller = new AbortController();
        setLoading(true);
        void listLocalVideos({ skuId: skuFilter, categoryIds: categoryFilter ? [categoryFilter] : undefined, status: statusFilter, page }, controller.signal)
            .then((result) => { if (controller.signal.aborted) return; setRows(result.items); setTotal(result.total); if (page > 1 && !result.items.length) setPage(1); })
            .catch((error) => { if (!controller.signal.aborted) report(error); })
            .finally(() => { if (!controller.signal.aborted) setLoading(false); });
        return () => controller.abort();
    }, [skuFilter, categoryFilter, statusFilter, page, revision, report]);
    const refresh = () => setRevision((value) => value + 1);

    useEffect(() => { void materialIndexStatus().then(setIndexStatus).catch(report); }, [revision, report]);
    useEffect(() => {
        if (!rows.some((r) => ["queued", "indexing"].includes(r.analysisStatus))) return;
        const timer = setInterval(() => setRevision((v) => v+1), 4000);
        return () => clearInterval(timer);
    }, [rows]);
    async function analyze(ids: string[]) {
        try { await analyzeMaterials(ids); message.success("分析已排队；上传成功的文件无需重新上传"); refresh(); }
        catch (error) { report(error); }
    }
    async function deleteSelected() {
        try { await Promise.all(selected.map((id) => deleteLocalVideo(id))); message.success(`已删除 ${selected.length} 条素材`); setSelected([]); refresh(); }
        catch (error) { report(error); }
    }
    async function purgeBySku() {
        if (!purgeTarget) return;
        const sku = skus.find((s) => s.id === purgeTarget);
        try {
            const { total } = await listLocalVideos({ skuId: purgeTarget, pageSize: 1 });
            Modal.confirm({
                title: `删除货号「${sku?.name ?? ""}」的全部 ${total} 条素材？`,
                content: "素材将退出素材库（软删除），已提交的剪辑任务不受影响，服务器上的视频文件暂不清理。",
                okText: "全部删除", okButtonProps: { danger: true },
                onOk: async () => {
                    const result = await deleteLocalVideosBySku(purgeTarget);
                    message.success(`已删除 ${result.count} 条素材`);
                    setPurgeTarget(undefined);
                    refresh();
                },
            });
        } catch (error) { report(error); }
    }
    async function saveName() {
        if (!nameEditor || saving) return;
        setSaving(true);
        try {
            const saved = await saveLibraryOption(nameEditor.kind, nameEditor.name, nameEditor.id);
            if (uploadOpen && !nameEditor.id) {
                if (nameEditor.kind === "skus") setUploadSku(saved.id); else setUploadCategory(saved.id);
            }
            setNameEditor(undefined); await refreshOptions(); refresh();
        } catch (error) { report(error); } finally { setSaving(false); }
    }
    async function removeOption(kind: LibraryKind, id: string) {
        try { await deleteLibraryOption(kind, id); await refreshOptions(); if (categoryFilter === id) setCategoryFilter(undefined); }
        catch (error) { report(error); }
    }
    async function startUpload() {
        if (uploadLock.current || !uploadSku || !uploadCategory) return;
        uploadLock.current = true; setUploading(true);
        const skuId = uploadSku, categoryId = uploadCategory;
        const notes = uploadNotes;
        try {
            for (const item of files.filter((entry) => entry.status === "待上传" || entry.status === "失败")) {
                setFiles((current) => current.map((entry) => entry.id === item.id ? { ...entry, status: "上传中", error: undefined } : entry));
                try {
                    await uploadLocalVideo(item.file, skuId, categoryId, notes);
                    setFiles((current) => current.map((entry) => entry.id === item.id ? { ...entry, status: "成功" } : entry));
                } catch (error) {
                    setFiles((current) => current.map((entry) => entry.id === item.id ? { ...entry, status: "失败", error: error instanceof Error ? error.message : "上传失败" } : entry));
                }
            }
            setUploadNotes("");
        } finally { uploadLock.current = false; setUploading(false); refresh(); }
    }
    async function saveAssignment() {
        if (!editing || !editSku || !editCategory || saving) return;
        setSaving(true);
        try { await assignLocalVideo(editing.id, editSku, editCategory); setEditing(undefined); refresh(); }
        catch (error) { report(error); } finally { setSaving(false); }
    }

    return (
        <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
            <PageHeader
                icon={FolderOpen}
                tone={AMBER_TONE}
                title="本地素材库"
                description="全体成员共享 · 仅支持视频 · 按货号和分类归档"
                actions={<>
                    <Link to="/auto-video"><Button type="text" icon={<Clapperboard className="size-4" />}>剪辑工作台</Button></Link>
                    <Link to="/auto-video/search"><Button type="text" icon={<ScanSearch className="size-4" />}>画面查询</Button></Link>
                    <Button onClick={() => { setManager("skus"); void refreshOptions().catch(report); }}>管理货号</Button>
                    <Button onClick={() => { setManager("categories"); void refreshOptions().catch(report); }}>管理分类</Button>
                    <Button type="primary" icon={<UploadIcon className="size-4" />} onClick={() => { setFiles([]); setUploadOpen(true); void refreshOptions().catch(report); }}>上传视频</Button>
                </>}
            />

            <div className="flex flex-wrap items-center gap-2 border-b border-border px-6 py-3">
                <Button disabled={!selected.length} onClick={() => void analyze(selected)}>分析所选 / 重试（{selected.length}）</Button>
                <Popconfirm title={`删除所选 ${selected.length} 条素材？`} description="将退出素材库，已提交任务不受影响。" onConfirm={() => void deleteSelected()}>
                    <Button danger disabled={!selected.length}>删除所选</Button>
                </Popconfirm>
                <Select allowClear showSearch optionFilterProp="label" placeholder="全部货号" className="w-56" value={skuFilter} options={optionItems(skus)} onChange={(value) => { setSkuFilter(value); setPage(1); }} />
                <Select allowClear showSearch optionFilterProp="label" placeholder="全部分类" className="min-w-44" value={categoryFilter} options={optionItems(categories)} onChange={(value) => { setCategoryFilter(value); setPage(1); }} />
                <Select allowClear placeholder="全部状态" className="min-w-36" value={statusFilter} options={Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label }))} onChange={(value) => { setStatusFilter(value); setPage(1); }} />
                <Select allowClear showSearch optionFilterProp="label" placeholder="按货号清空…" className="min-w-44" value={purgeTarget} options={optionItems(skus)} onChange={setPurgeTarget} />
                <Button danger disabled={!purgeTarget} onClick={() => void purgeBySku()}>删除该货号全部</Button>
                <Button icon={<RefreshCw className="size-4" />} onClick={() => { refresh(); void refreshOptions().catch(report); }}>刷新</Button>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-4">
                {indexStatus && (
                    <Alert
                        className="mb-4"
                        type={indexStatus.ready < indexStatus.total ? "warning" : "info"}
                        title={`当前模型索引可用 ${indexStatus.ready} / ${indexStatus.total} 条${indexStatus.configured ? "" : " · 请先配置向量模型"}`}
                        description="已有素材需主动分析；待确认、禁用和索引未完成的素材不会自动匹配。"
                    />
                )}
                <div className="overflow-hidden rounded-xl border border-border bg-card">
                    <Table<LocalVideo> rowKey="id" rowSelection={{ selectedRowKeys: selected, onChange: (keys) => setSelected(keys as string[]) }} loading={loading} dataSource={rows} scroll={{ x: 1400 }} pagination={{ current: page, pageSize: 20, total, showSizeChanger: false, onChange: setPage }} columns={[
                        { title: "视频", width: 210, render: (_, row) => (
                            <div className="flex items-center gap-3">
                                {row.thumbnail
                                    ? <img src={row.thumbnail} className="h-14 w-24 shrink-0 rounded-md object-cover" alt={row.fileName} />
                                    : <div className="grid h-14 w-24 shrink-0 place-items-center rounded-md bg-muted text-xs text-muted-foreground">无缩略图</div>}
                                <div className="min-w-0">
                                    <p className="truncate text-sm font-medium" title={row.fileName}>{row.fileName}</p>
                                    <p className="text-xs text-muted-foreground">{row.duration ? `${row.duration.toFixed(2)} 秒 · ${row.width}×${row.height}` : "媒体待探测"}</p>
                                </div>
                            </div>
                        ) },
                        { title: "简介 / 标签", width: 260, render: (_, row) => (
                            <div>
                                <p className="text-sm">{row.annotation?.summary ?? "待分析"}</p>
                                <div className="mt-1 flex flex-wrap gap-1">
                                    {row.annotation?.tags.map((t) => <span key={t} className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{t}</span>)}
                                </div>
                                {row.annotation?.warnings.map((w) => <p key={w} className="mt-1 text-xs text-amber-600 dark:text-amber-400">{w}</p>)}
                            </div>
                        ) },
                        { title: "备注", width: 160, ellipsis: true, render: (_, row) => row.notes || <span className="text-muted-foreground">—</span> },
                        { title: "分析状态", width: 180, render: (_, row) => (
                            <div className="space-y-2">
                                <div className="flex flex-wrap items-center gap-1.5">
                                    <StatusBadge tone={STATUS_TONES[row.analysisStatus] ?? "muted"} label={STATUS_LABELS[row.analysisStatus] ?? row.analysisStatus} pulse={["queued", "indexing"].includes(row.analysisStatus)} />
                                    {row.disabled && <StatusBadge tone="error" label="已禁用" />}
                                </div>
                                {row.analysisError && <p className="text-xs text-red-600 dark:text-red-400">{row.analysisError}</p>}
                                <Space wrap>
                                    <Button size="small" onClick={() => void analyze([row.id])}>分析 / 重试</Button>
                                    <Button size="small" onClick={() => setAnnotationEditor(row)}>编辑标注</Button>
                                    <Button size="small" onClick={async () => { try { await annotateMaterial(row.id, { revision: row.revision, disabled: !row.disabled }); refresh(); } catch (e) { report(e); } }}>{row.disabled ? "启用" : "禁用"}</Button>
                                </Space>
                            </div>
                        ) },
                        { title: "货号", render: (_, row) => row.sku.name },
                        { title: "分类", render: (_, row) => row.category.name },
                        { title: "大小", render: (_, row) => `${(row.bytes / 1024 / 1024).toFixed(1)} MB` },
                        { title: "上传者", render: (_, row) => row.uploadedBy.username },
                        { title: "上传时间", render: (_, row) => <span className="text-muted-foreground">{new Date(row.createdAt).toLocaleString()}</span> },
                        { title: "操作", render: (_, row) => (
                            <Space>
                                <Button size="small" onClick={() => setPreview(row)}>预览</Button>
                                <Button size="small" onClick={() => { setEditing(row); setEditSku(row.skuId); setEditCategory(row.categoryId); void refreshOptions().catch(report); }}>归类</Button>
                                <Popconfirm title="删除该素材？" description="将退出素材库，已提交任务不受影响。文件暂不清理。" onConfirm={async () => { try { await deleteLocalVideo(row.id); refresh(); } catch (error) { report(error); } }}>
                                    <Button size="small" danger>删除</Button>
                                </Popconfirm>
                            </Space>
                        ) },
                    ]} />
                </div>
            </div>

            <Modal open={!!manager} title={manager === "skus" ? "管理货号" : "管理分类"} onCancel={() => setManager(undefined)} footer={null}>
                <Button className="mb-3" onClick={() => manager && setNameEditor({ kind: manager, name: "" })}>新增{manager === "skus" ? "货号" : "分类"}</Button>
                <Table<LibraryOption> rowKey="id" size="small" dataSource={manager === "skus" ? skus : categories} pagination={{ pageSize: 8 }} columns={[
                    { title: "名称", dataIndex: "name" }, { title: "操作", render: (_, row) => <Space><Button size="small" onClick={() => manager && setNameEditor({ kind: manager, id: row.id, name: row.name })}>改名</Button><Popconfirm title="确认删除？有素材引用时无法删除。" onConfirm={() => manager && removeOption(manager, row.id)}><Button danger size="small">删除</Button></Popconfirm></Space> },
                ]} />
            </Modal>
            <Modal open={uploadOpen} title="上传视频" onCancel={() => !uploading && setUploadOpen(false)} closable={!uploading} maskClosable={!uploading} footer={<Space><Button disabled={uploading} onClick={() => setUploadOpen(false)}>关闭</Button><Button type="primary" loading={uploading} disabled={!skus.some((item) => item.id === uploadSku) || !categories.some((item) => item.id === uploadCategory) || !files.some((item) => item.status === "待上传" || item.status === "失败")} onClick={startUpload}>上传待处理文件 / 重试失败项</Button></Space>}>
                <div className="flex flex-col gap-4">
                    <FormSection title="归档位置">
                        <Field label="货号（必填）">
                            <Space.Compact className="w-full"><Select aria-label="上传货号" className="flex-1" placeholder="选择货号" showSearch optionFilterProp="label" value={uploadSku} options={optionItems(skus)} onChange={setUploadSku} disabled={uploading} /><Button disabled={uploading} onClick={() => setNameEditor({ kind: "skus", name: "" })}>新增货号</Button></Space.Compact>
                        </Field>
                        <Field label="分类（必填）">
                            <Space.Compact className="w-full"><Select aria-label="上传分类" className="flex-1" placeholder="选择分类" showSearch optionFilterProp="label" value={uploadCategory} options={optionItems(categories)} onChange={setUploadCategory} disabled={uploading} /><Button disabled={uploading} onClick={() => setNameEditor({ kind: "categories", name: "" })}>新增分类</Button></Space.Compact>
                        </Field>
                    </FormSection>
                    <FormSection title="备注与文件">
                        <Field label="备注（可选）">
                            <Input.TextArea rows={2} maxLength={500} disabled={uploading} value={uploadNotes} onChange={(event) => setUploadNotes(event.target.value)} placeholder="产品型号、卖点、颜色等文字信息，会参与画面匹配；本次选择的全部文件共用该备注" />
                        </Field>
                        <Upload multiple accept=".mp4,.mov,.avi,.flv,.mkv,.webm" showUploadList={false} disabled={uploading} beforeUpload={(file) => {
                            if (!/\.(mp4|mov|avi|flv|mkv|webm)$/i.test(file.name) || file.size > 200 * 1024 * 1024 || !file.size) { message.error(`${file.name}：请选择不超过 200 MB 的有效视频`); return false; }
                            setFiles((current) => [...current, { id: file.uid, file, status: "待上传" }]); return false;
                        }}><Button disabled={uploading} icon={<UploadIcon className="size-4" />}>选择视频（可多选）</Button></Upload>
                        <div className="max-h-72 space-y-2 overflow-auto">
                            {files.map((item) => (
                                <div key={item.id} className="rounded-lg border border-border px-3 py-2">
                                    <div className="flex items-center gap-2">
                                        <span className="min-w-0 flex-1 truncate text-sm">{item.file.name}</span>
                                        <StatusBadge tone={item.status === "失败" ? "error" : item.status === "成功" ? "success" : item.status === "上传中" ? "processing" : "muted"} label={item.status} pulse={item.status === "上传中"} />
                                        {!uploading && item.status !== "成功" && <Button size="small" type="text" onClick={() => setFiles((current) => current.filter((entry) => entry.id !== item.id))}>移除</Button>}
                                    </div>
                                    {item.error && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{item.error}</p>}
                                </div>
                            ))}
                        </div>
                        <Alert type="info" showIcon title="上传成功后会排队进行 AI 分析；分析失败可在素材列表重试，无需重新上传。中文文件名原样保留。" />
                    </FormSection>
                </div>
            </Modal>
            <Modal open={!!nameEditor} title={`${nameEditor?.id ? "修改" : "新增"}${nameEditor?.kind === "skus" ? "货号" : "分类"}`} onCancel={() => !saving && setNameEditor(undefined)} onOk={saveName} confirmLoading={saving} okButtonProps={{ disabled: !nameEditor?.name.trim() }}>
                <Input autoFocus maxLength={100} value={nameEditor?.name ?? ""} onChange={(event) => setNameEditor((current) => current ? { ...current, name: event.target.value } : current)} onPressEnter={saveName} placeholder="全库唯一，忽略首尾空格和英文字母大小写" />
            </Modal>
            <Modal open={!!editing} title="修改素材归属" onCancel={() => !saving && setEditing(undefined)} onOk={saveAssignment} confirmLoading={saving} okButtonProps={{ disabled: !editSku || !editCategory }}>
                <div className="flex flex-col gap-3">
                    <Field label="货号"><Select className="w-full" showSearch optionFilterProp="label" value={editSku} options={optionItems(skus)} onChange={setEditSku} /></Field>
                    <Field label="分类"><Select className="w-full" showSearch optionFilterProp="label" value={editCategory} options={optionItems(categories)} onChange={setEditCategory} /></Field>
                </div>
            </Modal>
            {annotationEditor && <MaterialAnnotationEditor key={annotationEditor.id} item={annotationEditor} close={() => setAnnotationEditor(undefined)} saved={refresh} />}
            <Modal open={!!preview} title={preview?.fileName} onCancel={() => setPreview(undefined)} footer={null} width={800} destroyOnHidden>
                {preview && <video key={preview.id} src={localVideoUrl(preview.id)} controls className="max-h-[65vh] w-full rounded-lg" />}
            </Modal>
        </div>
    );
}

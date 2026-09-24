import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Alert, App, Button, Checkbox, Input, InputNumber, Modal, Select, Space, Spin, Table, Tabs } from "antd";
import { Clapperboard, Film, FolderOpen, RefreshCw, ScanSearch } from "lucide-react";
import { availableCategories, listLibraryOptions, localVideoUrl, type LibraryOption } from "@/services/local-materials";
import { Field } from "@/components/ui/form-section";
import { PageHeader } from "@/components/ui/page-header";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { planAudio, planVideo, semanticApi, type Plan, type Shot, type UnitEdit } from "../semantic-api";
import PlanPreview from "./plan-preview";

const labels: Record<string,string> = { queued: "排队中", running: "处理中", ready: "待预览确认", failed: "失败", succeeded: "已完成" };
const tones: Record<string, StatusTone> = { queued: "processing", running: "processing", ready: "warning", failed: "error", succeeded: "success" };
const AMBER_TONE = "bg-amber-500/10 text-amber-600 dark:text-amber-400";
const coverage = (edit: UnitEdit) => edit.shots.reduce((sum, s) => sum + s.frames, 0);
// 转场效果中文名；undefined 表示跟随方案级 video_transition。
const TRANSITIONS: Record<string, string> = { none: "无 · 硬切", fade: "溶解", slide_left: "左滑", slide_right: "右滑", slide_up: "上滑", wipe_left: "左擦除", circle_open: "圆形展开", radial: "径向", pixelize: "像素化", hblur: "模糊", shuffle: "每段随机" };
const transitionOptions = (defaultLabel: string) => [
    { value: "__default", label: `跟随方案（${defaultLabel}）` },
    ...Object.entries(TRANSITIONS).map(([value, label]) => ({ value, label })),
];

export default function AutoVideoPlans() {
    const { id } = useParams();
    const { message } = App.useApp();
    const audition = useRef<HTMLAudioElement | null>(null);
    useEffect(() => () => { audition.current?.pause(); }, [id]);
    const [plans, setPlans] = useState<Plan[]>([]), [plan, setPlan] = useState<Plan>();
    const [error, setError] = useState(""), [busy, setBusy] = useState(false), [variant, setVariant] = useState(0);
    const [textEditor, setTextEditor] = useState<{ unit: number; text: string; revision: number }>();
    const [editor, setEditor] = useState<{ unit: number; value: UnitEdit; revision: number }>();
    const [preview, setPreview] = useState<{ unit?: number }>(), [clip, setClip] = useState<string>();
    const [rebuild, setRebuild] = useState<Record<string, any>>(), [options, setOptions] = useState<Record<string, any>>();
    const [skus, setSkus] = useState<LibraryOption[]>([]), [categories, setCategories] = useState<LibraryOption[]>([]);
    const [jianying, setJianying] = useState<{ open: boolean; folder: string; detected: boolean; pack: boolean }>({ open: false, folder: "", detected: false, pack: true });
    const load = useCallback(async () => {
    try { if (id) { const next = await semanticApi<Plan>(`/plans/${id}`, undefined, "GET"); setPlan((old) => JSON.stringify(old) === JSON.stringify(next) ? old : next); } else setPlans(await semanticApi<Plan[]>("/plans", undefined, "GET")); setError(""); }
        catch (e) { setError(e instanceof Error ? e.message : "读取失败"); }
    }, [id]);
    useEffect(() => { setPlan(undefined); setVariant(0); setEditor(undefined); setPreview(undefined); void load(); const timer = setInterval(() => void load(), 5000); return () => clearInterval(timer); }, [load]);
    useEffect(() => { if (rebuild) void listLibraryOptions("skus").then(setSkus).catch(() => undefined); }, [!!rebuild]);
    useEffect(() => { if (rebuild?.skuId) void availableCategories(rebuild.skuId).then(setCategories).catch(() => undefined); }, [rebuild?.skuId]);
    async function act(path: string, body: unknown, method = "POST") {
        if (busy) return;
        setBusy(true);
        try { await semanticApi(path, body, method); await load(); return true; }
        catch (e) { message.error(e instanceof Error ? e.message : "操作失败"); await load(); return false; }
        finally { setBusy(false); }
    }
    const doc = plan?.document;
    const selected = doc?.variants[variant];
    const complete = !!doc && !!selected && selected.every((e,i) => e.confirmed && coverage(e) === doc.units[i].endFrame-doc.units[i].startFrame);
    function updateShot(index: number, patch: Partial<Shot>) {
        if (!editor) return;
        const shots = editor.value.shots.map((s,i) => i === index ? { ...s, ...patch, manual: true } : s).map((s) => ({ ...s, frames: Math.floor((s.sourceEnd-s.sourceStart)/s.speed*30+1e-6) }));
        setEditor({ ...editor, value: { ...editor.value, shots, confirmed: false } });
    }
    async function openJianying() {
        setJianying({ open: true, folder: "", detected: false, pack: true });
        try {
            const target = await semanticApi<{ folder: string; inJianYing: boolean }>("/jianying/target", undefined, "GET");
            setJianying((s) => ({ ...s, folder: target.folder, detected: target.inJianYing }));
        } catch { setJianying((s) => ({ ...s, folder: "", detected: false })); }
    }
    async function exportJianYing() {
        if (busy || !plan || !id) return;
        setBusy(true);
        try {
            const result = await semanticApi<{ name: string; path: string; inJianYing: boolean; customDir: boolean; replacedGaps: number }>(`/plans/${id}/jianying`, { revision: plan.revision, variant, folder: jianying.folder.trim() || undefined, packMaterials: jianying.pack });
            setJianying((s) => ({ ...s, open: false }));
            if (result.inJianYing) message.success(`已写入剪映草稿「${result.name}」（${result.path}），打开剪映专业版即可编辑；若草稿列表未出现，重启剪映后会重新扫描；画面、旁白、字幕已分轨${result.replacedGaps ? `；${result.replacedGaps} 个缺失镜头已用黑场代替` : ""}`, 10);
            else message.success(`已导出到 ${result.path}；在剪映里通过"导入草稿"选择该文件夹即可编辑。画面、旁白、字幕已分轨${result.replacedGaps ? `；${result.replacedGaps} 个缺失镜头已用黑场代替` : ""}`, 10);
        } catch (e) { message.error(e instanceof Error ? e.message : "导出失败"); }
        finally { setBusy(false); }
    }
    async function pickFolder() {
        try {
            const picked = await semanticApi<{ folder: string | null }>("/pick-folder", {});
            if (picked.folder) setJianying((s) => ({ ...s, folder: picked.folder! }));
        } catch (e) { message.error(e instanceof Error ? e.message : "无法打开选择对话框"); }
    }

    const navActions = <>
        <Link to="/auto-video"><Button type="text" icon={<Clapperboard className="size-4" />}>剪辑工作台</Button></Link>
        <Link to="/auto-video/materials"><Button type="text" icon={<FolderOpen className="size-4" />}>素材库</Button></Link>
        <Link to="/auto-video/search"><Button type="text" icon={<ScanSearch className="size-4" />}>画面查询</Button></Link>
        <Button icon={<RefreshCw className="size-4" />} onClick={() => void load()}>刷新</Button>
    </>;

    return (
        <main className="flex h-full min-h-0 flex-col bg-background text-foreground">
            <PageHeader
                icon={Film}
                tone={AMBER_TONE}
                title={id ? "剪辑方案详情" : "本地剪辑方案"}
                description={id && plan ? `本地语义剪辑 · 版本 ${plan.revision}` : "查看与调整本地语义剪辑方案"}
                actions={navActions}
            />

            <div className="flex-1 overflow-y-auto px-6 py-5">
                {error && <Alert type="error" title={error} className="mb-4" />}
                {!id ? (
                    <div className="overflow-hidden rounded-xl border border-border bg-card">
                        <Table<Plan> rowKey="id" dataSource={plans} columns={[
                            { title: "原文", render: (_, p) => <Link to={`/auto-video/plans/${p.id}`} className="hover:text-primary">{p.input.script.slice(0,80)}</Link> },
                            { title: "状态", width: 130, render: (_, p) => <StatusBadge tone={tones[p.status] ?? "muted"} label={labels[p.status] ?? p.status} pulse={p.status === "queued" || p.status === "running"} /> },
                            { title: "创建时间", width: 180, render: (_, p) => <span className="text-muted-foreground">{new Date(p.createdAt).toLocaleString()}</span> },
                            { title: "错误", dataIndex: "error", render: (value: string) => value ? <span className="text-red-600 dark:text-red-400">{value}</span> : <span className="text-muted-foreground">—</span> },
                        ]} />
                    </div>
                ) : !plan ? <div className="flex justify-center py-16"><Spin /></div> : <>
                    <section className="mb-4 rounded-xl border border-border bg-card p-5">
                        <div className="flex flex-wrap items-center gap-2.5">
                            <StatusBadge tone={tones[plan.status] ?? "muted"} label={labels[plan.status] ?? plan.status} pulse={plan.status === "queued" || plan.status === "running"} />
                            <span className="text-xs text-muted-foreground">创建于 {new Date(plan.createdAt).toLocaleString()}</span>
                        </div>
                        <p className="mt-3 whitespace-pre-wrap text-sm leading-6">{plan.input.script}</p>
                        {plan.error && <Alert className="mt-3" type="error" title={plan.error} />}
                        <Space wrap className="mt-4">
                            <Button disabled={busy || plan.status === "queued"} onClick={() => setRebuild(structuredClone(plan.input))}>修改原文 / 配音 / 筛选范围</Button>
                            <Button disabled={busy || plan.status === "queued"} onClick={() => void act(`/plans/${id}/rematch`, { revision: plan.revision })}>重新分析整个方案</Button>
                            <Button disabled={busy || plan.status !== "ready"} onClick={() => doc && setOptions({ ...doc.options })}>画幅 / 字幕 / 配乐</Button>
                        </Space>
                        {plan.status === "queued" && <Alert className="mt-3" type="info" title="正在后台理解文案、生成配音并检索素材，可离开页面稍后回来。" />}
                    </section>

                    {doc && plan.status === "ready" && <>
                        <Tabs activeKey={String(variant)} onChange={(k) => { setVariant(Number(k)); setEditor(undefined); setPreview(undefined); }} items={doc.variants.map((_,i) => ({ key: String(i), label: `成片方案 ${i+1}` }))} />
                        <div className="mb-4 flex flex-wrap items-center gap-2">
                            <Button onClick={() => setPreview({})}>轻量合成预览</Button>
                            <Button disabled={busy} onClick={() => void openJianying()}>导出剪映工程</Button>
                            <Button type="primary" disabled={!complete || busy} onClick={() => void act(`/plans/${id}/render`, { revision: plan.revision, variant, requestId: crypto.randomUUID() })}>确认并生成本条成片</Button>
                            <span className="text-xs text-muted-foreground">逐句确认、解决全部缺口后可生成。每条成片单独确认。</span>
                        </div>
                        {doc.units.map((u,i) => {
                            const edit = selected![i], frames = u.endFrame-u.startFrame, diff = frames-coverage(edit);
                            const unitTone: StatusTone = diff ? "error" : edit.confirmed ? "success" : "warning";
                            const unitLabel = diff > 0 ? `缺少 ${(diff/30).toFixed(2)} 秒` : diff < 0 ? `超出 ${(-diff/30).toFixed(2)} 秒` : edit.confirmed ? "已确认" : "待确认";
                            return (
                                <section key={i} className="mb-3 rounded-xl border border-border bg-card p-4">
                                    <div className="flex flex-wrap items-center gap-2.5">
                                        <span className="grid size-5 shrink-0 place-items-center rounded-full bg-primary/10 text-[11px] font-semibold text-primary">{i+1}</span>
                                        <h3 className="min-w-0 flex-1 text-sm font-medium">{u.text}</h3>
                                        <StatusBadge tone={unitTone} label={unitLabel} />
                                    </div>
                                    <p className="mt-2 text-xs text-muted-foreground">{(u.startFrame/30).toFixed(2)}–{(u.endFrame/30).toFixed(2)} 秒 · 需要 {(frames/30).toFixed(2)} 秒 · 已覆盖 {(coverage(edit)/30).toFixed(2)} 秒</p>
                                    <p className="mt-1 text-xs text-muted-foreground">画面需求：{u.query}；必要证据：{u.evidence.join("、") || "通用展示"}</p>
                                    <div className="my-3 flex flex-wrap gap-2">
                                        {edit.shots.map((s,j) => {
                                            const c = u.candidates.find((c) => c.id === s.materialId)!;
                                            const repeated = selected!.flatMap((e) => e.shots).filter((x) => x.materialId === s.materialId).length > 1;
                                            const other = doc.variants.filter((v,k) => k !== variant && v.some((e) => e.shots.some((x) => x.materialId === s.materialId))).length;
                                            return (
                                                <div key={j} className="w-60 rounded-lg border border-border bg-background p-2.5">
                                                    <button type="button" className="w-full truncate text-left text-xs font-medium text-primary hover:underline" title={c.fileName} onClick={() => setClip(c.id)}>{j+1}. {c.fileName}</button>
                                                    <p className="mt-1 text-xs text-muted-foreground">{s.sourceStart.toFixed(2)}–{s.sourceEnd.toFixed(2)} 秒 · {s.speed}×</p>
                                                    {(i > 0 || j > 0) && s.transition && <p className="mt-1 text-xs text-muted-foreground">衔接转场：{TRANSITIONS[s.transition] ?? s.transition}</p>}
                                                    <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{c.reason}</p>
                                                    <div className="mt-1.5 flex flex-wrap gap-1">
                                                        <span className={`rounded px-1.5 py-0.5 text-[11px] ${c.grade === "strong" ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "bg-amber-500/10 text-amber-600 dark:text-amber-400"}`}>{c.grade === "strong" ? "相关" : "需人工判断"}</span>
                                                        {repeated && <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[11px] text-amber-600 dark:text-amber-400">本条重复</span>}
                                                        {other > 0 && <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">另 {other} 条方案也使用</span>}
                                                    </div>
                                                    {c.missing.length > 0 && <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">缺少证据：{c.missing.join("、")}</p>}
                                                </div>
                                            );
                                        })}
                                    </div>
                                    <Space wrap>
                                        <Button onClick={() => setPreview({ unit: i })}>本句画面与旁白</Button>
                                        <Button onClick={() => { audition.current?.pause(); const a = new Audio(planAudio(plan.id)); audition.current = a; a.currentTime = u.startFrame/30; a.ontimeupdate = () => { if (a.currentTime >= u.endFrame/30) a.pause(); }; void a.play().catch(() => message.error("试听失败")); }}>单句试听</Button>
                                        <Button onClick={() => setEditor({ unit: i, value: structuredClone(edit), revision: plan.revision })}>替换 / 排序 / 裁剪 / 确认</Button>
                                        <Button disabled={busy} onClick={() => void act(`/plans/${id}/rematch`, { revision: plan.revision, units: [i] })}>重新匹配本句</Button>
                                        <Button onClick={() => setTextEditor({ unit: i, text: u.text, revision: plan.revision })}>修改本句文案</Button>
                                    </Space>
                                </section>
                            );
                        })}
                    </>}

                    {plan.jobs?.filter((j) => j.kind === "render").map((j) => (
                        <section className="mb-3 rounded-xl border border-border bg-card p-4" key={j.id}>
                            <div className="mb-3 flex items-center gap-2.5">
                                <h3 className="text-sm font-medium">成片 {Number(j.dedupeKey.split(":").at(-1))+1} · 版本 {j.dedupeKey.split(":").at(-2)}</h3>
                                <StatusBadge tone={tones[j.status] ?? "muted"} label={labels[j.status] ?? j.status} pulse={j.status === "queued" || j.status === "running"} />
                            </div>
                            {j.error && <Alert type="error" title={j.error} className="mb-3" />}
                            {j.status === "failed" && <Button disabled={busy} onClick={() => void act(`/plans/${id}/jobs/${j.id}/retry`, {})}>重试此快照</Button>}
                            {j.status === "succeeded" && <>
                                <video src={planVideo(plan.id,j.id)} controls className="max-h-96 w-full rounded-lg" />
                                <a href={planVideo(plan.id,j.id)} download={`成片-${j.id}.mp4`} className="mt-2 inline-block text-sm text-primary hover:underline">下载成片</a>
                                {j.result?.warnings?.map((w) => <Alert key={w} type="warning" title={w} className="mt-2" />)}
                            </>}
                        </section>
                    ))}
                </>}
            </div>

            <Modal open={!!editor} width={950} title="调整本句镜头" onCancel={() => setEditor(undefined)} confirmLoading={busy} okText="保存本句" onOk={async () => {
                if (editor && await act(`/plans/${id}`, { revision: editor.revision, edit: { variant, unit: editor.unit, ...editor.value } }, "PATCH")) setEditor(undefined);
            }}>
                {editor && doc && <div className="flex flex-col gap-3">
                    <p className="text-sm font-medium">{doc.units[editor.unit].text}</p>
                    <Alert type="info" title={`需要 ${((doc.units[editor.unit].endFrame-doc.units[editor.unit].startFrame)/30).toFixed(2)} 秒；当前 ${(coverage(editor.value)/30).toFixed(2)} 秒。以 30 fps 量化，末镜可裁短。`} />
                    {editor.value.shots.map((s,i) => (
                        <div key={i} className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-3 py-2">
                            <span className="min-w-0 flex-1 truncate text-sm">{i+1}. {doc.units[editor.unit].candidates.find((c) => c.id === s.materialId)?.fileName}</span>
                            <label className="flex items-center gap-1 text-xs text-muted-foreground">起点 <InputNumber size="small" min={0} step={1/30} precision={6} value={s.sourceStart} onChange={(v) => updateShot(i, { sourceStart: v ?? 0 })} /></label>
                            <label className="flex items-center gap-1 text-xs text-muted-foreground">终点 <InputNumber size="small" min={0} max={doc.units[editor.unit].candidates.find((c) => c.id === s.materialId)?.duration} step={1/30} precision={6} value={s.sourceEnd} onChange={(v) => updateShot(i, { sourceEnd: v ?? 0 })} /></label>
                            <Select aria-label="速度" size="small" value={s.speed} options={[1,.95,.9,.85,.8].map((v) => ({ value: v, label: `${v}×${v < 1 ? '（主动慢放）' : ''}` }))} onChange={(v) => updateShot(i, { speed: v })} />
                            {!(editor.unit === 0 && i === 0) && <Select aria-label="衔接转场" size="small" popupMatchSelectWidth={false} className="min-w-32" value={s.transition ?? "__default"} options={transitionOptions(TRANSITIONS[doc.options.video_transition] ?? "无 · 硬切")} onChange={(v) => updateShot(i, { transition: v === "__default" ? undefined : v })} />}
                            <Button size="small" disabled={!i} onClick={() => { const shots = [...editor.value.shots]; [shots[i-1],shots[i]]=[shots[i],shots[i-1]]; setEditor({ ...editor,value:{...editor.value,shots,confirmed:false} }); }}>上移</Button>
                            <Button size="small" onClick={() => setEditor({ ...editor, value: { ...editor.value, shots: editor.value.shots.filter((_,j) => i !== j), confirmed: false } })}>移除</Button>
                            <Button size="small" onClick={() => setClip(s.materialId)}>预览</Button>
                        </div>
                    ))}
                    <Select<string> showSearch optionFilterProp="label" placeholder="手动添加候选镜头（可添加多个）" value={undefined} options={doc.units[editor.unit].candidates.map((c) => ({ value: c.id, label: `${c.fileName} · ${c.duration.toFixed(2)}秒 · ${c.grade === "strong" ? "相关" : "待判断"} · ${c.reason}${c.missing.length ? ' · 缺少：'+c.missing.join('、') : ''}` }))}
                        onChange={(materialId) => { const c = doc.units[editor.unit].candidates.find((c) => c.id === materialId)!; setEditor({ ...editor, value: { ...editor.value, confirmed: false, shots: [...editor.value.shots, { materialId, sourceStart: 0, sourceEnd: c.duration, speed: 1, frames: Math.floor(c.duration*30), manual: true }] } }); }} />
                    <Button onClick={() => {
                        const shots = structuredClone(editor.value.shots), last = shots.at(-1); if (!last) return;
                        const need = doc.units[editor.unit].endFrame-doc.units[editor.unit].startFrame - shots.slice(0,-1).reduce((n,s) => n+s.frames,0);
                        const c = doc.units[editor.unit].candidates.find((c) => c.id === last.materialId)!;
                        if (need <= 0 || last.sourceStart+need/30*last.speed > c.duration) { message.warning("末镜无法补齐，请调整镜头组合"); return; }
                        last.sourceEnd = last.sourceStart+need/30*last.speed; last.frames=need; last.manual=true;
                        setEditor({...editor,value:{...editor.value,shots,confirmed:false}});
                    }}>裁剪末镜以精确对齐本句</Button>
                    <Checkbox checked={editor.value.allowRepeat} onChange={(e) => setEditor({ ...editor, value: { ...editor.value, allowRepeat: e.target.checked, confirmed: false } })}>明确允许本句重复使用相关素材（不会自动补片）</Checkbox>
                    <Checkbox checked={editor.value.confirmed} onChange={(e) => setEditor({ ...editor, value: { ...editor.value, confirmed: e.target.checked } })}>已预览并确认这些画面；已检查相关性、缺失证据、重复和速度</Checkbox>
                    <Link to="/auto-video/materials" target="_blank" className="text-sm hover:text-primary">缺少合适素材：打开素材库上传并分析，再重匹配本句</Link>
                </div>}
            </Modal>
            <Modal open={!!preview} width={800} title="方案预览" footer={null} onCancel={() => setPreview(undefined)} destroyOnHidden>{preview && plan?.document && <PlanPreview key={`${variant}:${preview.unit ?? 'all'}`} plan={plan} variant={variant} unit={preview.unit} />}</Modal>
            <Modal open={!!clip} title="素材预览" footer={null} onCancel={() => setClip(undefined)} destroyOnHidden>{clip && <video src={localVideoUrl(clip)} controls className="max-h-[60vh] w-full rounded-lg" />}</Modal>
            <Modal open={jianying.open} title="导出剪映工程" confirmLoading={busy} onCancel={() => setJianying((s) => ({ ...s, open: false }))} onOk={() => void exportJianYing()}>
                <div className="flex flex-col gap-3">
                    <p className="text-sm text-muted-foreground">点击"浏览"选择导出文件夹（也可直接输入绝对路径），导出后不要手动移动草稿文件夹（旁白和黑场按绝对路径引用，移动会失联）。</p>
                <Space.Compact className="w-full"><Input value={jianying.folder} onChange={(e) => setJianying((s) => ({ ...s, folder: e.target.value }))} placeholder="留空自动检测剪映草稿目录" /><Button disabled={busy} onClick={() => void pickFolder()}>浏览…</Button></Space.Compact>
                {jianying.detected && <p className="text-sm text-muted-foreground">已自动定位剪映草稿库，留空即直接写入，打开剪映即可编辑。</p>}
                <Checkbox checked={jianying.pack} onChange={(e) => setJianying((s) => ({ ...s, pack: e.target.checked }))}>打包素材进草稿（复制一份到草稿文件夹内，源素材清理后草稿仍可打开；剪映只认绝对路径，草稿不能整体移动；草稿会变大，4K 素材每个约 30 MB）</Checkbox>
            </div>
        </Modal>
            <Modal open={!!textEditor} title="修改本句（仅重新配音并匹配本句，需重新确认方案）" onCancel={() => setTextEditor(undefined)} confirmLoading={busy} onOk={async () => {
                if (textEditor && await act(`/plans/${id}/rematch`, { revision: textEditor.revision, unit: textEditor.unit, unitText: textEditor.text })) setTextEditor(undefined);
            }}><Input.TextArea rows={5} value={textEditor?.text ?? ""} onChange={(e) => setTextEditor((old) => old ? { ...old, text: e.target.value } : old)} /></Modal>
            <Modal open={!!rebuild} title="修改后重新配音及匹配，原确认失效" onCancel={() => setRebuild(undefined)} confirmLoading={busy} onOk={async () => { if (rebuild && plan && await act(`/plans/${id}/rematch`, { revision: plan.revision, input: rebuild })) setRebuild(undefined); }}>
                {rebuild && <div className="flex flex-col gap-3">
                    <Field label="原文"><Input.TextArea rows={6} value={rebuild.script} onChange={(e) => setRebuild({...rebuild,script:e.target.value})} /></Field>
                    <Field label="货号"><Select className="w-full" aria-label="货号" value={rebuild.skuId} options={skus.map((s) => ({ value:s.id,label:s.name }))} onChange={(skuId) => setRebuild({...rebuild,skuId,categoryIds:[]})} /></Field>
                    <Field label="分类"><Select className="w-full" aria-label="分类" mode="multiple" value={rebuild.categoryIds} options={categories.map((c) => ({ value:c.id,label:c.name }))} onChange={(categoryIds) => setRebuild({...rebuild,categoryIds})} /></Field>
                    <div className="grid grid-cols-2 gap-3">
                        <Field label="系统音色"><Input value={rebuild.voiceName} onChange={(e) => setRebuild({...rebuild,voiceName:e.target.value})} /></Field>
                        <Field label="配音速度"><InputNumber className="w-full" min={.5} max={2} step={.1} value={rebuild.voiceRate} onChange={(v) => setRebuild({...rebuild,voiceRate:v})} /></Field>
                    </div>
                </div>}
            </Modal>
            <Modal open={!!options} title="调整输出样式（复用原配音与匹配）" onCancel={() => setOptions(undefined)} confirmLoading={busy} onOk={async () => { if (options && plan && await act(`/plans/${id}`, { revision: plan.revision, options }, "PATCH")) setOptions(undefined); }}>
                {options && <div className="flex flex-col gap-3">
                    <div className="grid grid-cols-2 gap-3">
                        <Field label="画面比例"><Select className="w-full" value={options.video_aspect} options={["9:16","16:9","1:1"].map((v)=>({value:v,label:v}))} onChange={(v)=>setOptions({...options,video_aspect:v})} /></Field>
                        <Field label="适应方式"><Select className="w-full" value={options.video_fit_mode} options={[{value:"cover",label:"填充"},{value:"contain",label:"完整"}]} onChange={(v)=>setOptions({...options,video_fit_mode:v})} /></Field>
                    </div>
                    <Checkbox checked={options.subtitle_enabled} onChange={(e)=>setOptions({...options,subtitle_enabled:e.target.checked})}>显示字幕</Checkbox>
                    <div className="grid grid-cols-2 gap-3">
                        <Field label="字幕字号"><InputNumber className="w-full" min={24} max={120} value={options.font_size} onChange={(v)=>setOptions({...options,font_size:v})} /></Field>
                        <Field label="字幕位置"><Select className="w-full" value={options.subtitle_position} options={[{value:"top",label:"顶部"},{value:"center",label:"居中"},{value:"bottom",label:"底部"}]} onChange={(v)=>setOptions({...options,subtitle_position:v})} /></Field>
                    </div>
                    <Field label="背景音乐"><Select className="w-full" value={options.bgm_type} options={[{value:"none",label:"不使用背景音乐"},{value:"random",label:"随机背景音乐"},{value:"custom",label:"指定已有音乐"}]} onChange={(v)=>setOptions({...options,bgm_type:v})} /></Field>
                    {options.bgm_type === "custom" && <Field label="音乐文件名"><Input placeholder="已上传音乐的文件名" value={options.bgm_file} onChange={(e)=>setOptions({...options,bgm_file:e.target.value})} /></Field>}
                    <Field label="音乐音量"><InputNumber className="w-full" min={0} max={1} step={.1} value={options.bgm_volume} onChange={(v)=>setOptions({...options,bgm_volume:v})} /></Field>
                </div>}
            </Modal>
        </main>
    );
}

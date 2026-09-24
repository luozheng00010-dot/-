import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Alert, App, Button, Input, Select, Space, Spin } from "antd";
import { Brain, Clapperboard, Eye, FolderCog, RefreshCw, Scissors, Settings2 } from "lucide-react";
import { useAuthStore } from "@/stores/use-auth-store";
import { Field } from "@/components/ui/form-section";
import { PageHeader } from "@/components/ui/page-header";
import { StatusBadge } from "@/components/ui/status-badge";
import { getAutoVideoSettings, saveAutoVideoSettings, type AutoVideoModelChannel, type AutoVideoModelSettings } from "../api";
import { semanticApi } from "../semantic-api";

const groups = [
    { title: "文案／匹配模型", channel: "channelId", model: "model", icon: Brain, help: "理解原文、拆解画面需求，并判断候选素材是否有对应证据。" },
    { title: "视觉分析模型", channel: "visionChannelId", model: "visionModel", icon: Eye, help: "分析按时间顺序抽取的画面。请选择支持图片输入的文字模型，可与文案模型相同。Gemini 原生渠道也可选：按抽帧图片分析（inline 图片），仅支持视觉，文案/向量仍选 OpenAI 兼容渠道。" },
    { title: "向量模型", channel: "embedChannelId", model: "embedModel", icon: Scissors, help: "请选择支持 embeddings 接口的模型；更换模型后需要重建素材索引。" },
] as const;

export default function AutoVideoAdminPage() {
    const { message } = App.useApp();
    const admin = useAuthStore((s) => s.user?.role === "admin");
    const [settings, setSettings] = useState<AutoVideoModelSettings>({ channelId: null, model: null });
    const [channels, setChannels] = useState<AutoVideoModelChannel[]>([]);
    const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState("");
    const load = useCallback(async () => {
        try { const r = await getAutoVideoSettings(); setSettings(r.settings); setChannels(r.channels); setError(""); }
        catch (e) { setError(e instanceof Error ? e.message : "加载失败"); }
        finally { setLoading(false); }
    }, []);
    useEffect(() => { if (admin) void load(); }, [admin, load]);
    async function pickFolder() {
        try {
            const picked = await semanticApi<{ folder: string | null }>("/pick-folder", {});
            if (picked.folder) setSettings((s) => ({ ...s, jianyingDir: picked.folder }));
        } catch (e) { message.error(e instanceof Error ? e.message : "无法打开选择对话框"); }
    }
    const valid = groups.every((g, i) => (i > 0 && !settings[g.channel] && !settings[g.model]) || channels.find((c) => c.id === settings[g.channel])?.models.includes(settings[g.model] ?? ""));
    async function act(task: () => Promise<unknown>, success: string) {
        setBusy(true);
        try { await task(); message.success(success); await load(); }
        catch (e) { message.error(e instanceof Error ? e.message : "操作失败"); }
        finally { setBusy(false); }
    }
    if (!admin) return <div className="p-6"><Alert type="warning" title="仅管理员可以管理自动剪辑模型" /></div>;
    return (
        <main className="flex h-full min-h-0 flex-col bg-background text-foreground">
            <PageHeader
                icon={Settings2}
                tone="bg-amber-500/10 text-amber-600 dark:text-amber-400"
                title="自动剪辑管理"
                description="模型渠道、存储位置与剪映导出"
                actions={<Link to="/auto-video"><Button type="text" icon={<Clapperboard className="size-4" />}>返回工作台</Button></Link>}
            />

            <div className="flex-1 overflow-y-auto px-6 py-5">
                {error && <Alert type="error" title={error} className="mb-4" />}
                {loading ? <div className="flex justify-center py-16"><Spin /></div> : (
                    <div className="mx-auto flex max-w-3xl flex-col gap-4">
                        <Alert type="info" title="复用主站渠道，密钥仅保留在主服务" description="支持 OpenAI 兼容接口。向量模型请在主站文字模型列表登记；视觉理解模型不能使用生图模型替代。已有素材不会自动消耗分析额度。" />
                        {groups.map((g) => (
                            <section key={g.model} className="rounded-xl border border-border bg-card p-5">
                                <div className="flex items-center gap-2.5">
                                    <span className="grid size-8 place-items-center rounded-lg bg-amber-500/10 text-amber-600 dark:text-amber-400"><g.icon className="size-4" /></span>
                                    <h2 className="text-sm font-semibold tracking-tight">{g.title}</h2>
                                </div>
                                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                                    <Field label="主站渠道">
                                        <Select className="w-full" placeholder="选择主站渠道" value={settings[g.channel] ?? undefined} disabled={busy} options={channels.map((c) => ({ value: c.id, label: c.name }))}
                                            onChange={(value) => setSettings((s) => ({ ...s, [g.channel]: value, [g.model]: null }))} />
                                    </Field>
                                    <Field label="模型">
                                        <Select className="w-full" showSearch placeholder="选择模型" value={settings[g.model] ?? undefined} disabled={busy || !settings[g.channel]} options={channels.find((c) => c.id === settings[g.channel])?.models.map((m) => ({ value: m, label: m }))}
                                            onChange={(value) => setSettings((s) => ({ ...s, [g.model]: value }))} />
                                    </Field>
                                </div>
                                <p className="mt-3 text-xs text-muted-foreground">{g.help}</p>
                            </section>
                        ))}
                        <section className="rounded-xl border border-border bg-card p-5">
                            <div className="flex items-center gap-2.5">
                                <span className="grid size-8 place-items-center rounded-lg bg-amber-500/10 text-amber-600 dark:text-amber-400"><FolderCog className="size-4" /></span>
                                <h2 className="text-sm font-semibold tracking-tight">素材存储位置</h2>
                            </div>
                            <div className="mt-4">
                                <Field label="剪辑引擎所在机器的绝对路径">
                                    <Input value={settings.storageDir ?? ""} disabled={busy} placeholder={settings.storageDefaultDir ?? "storage/local_videos"}
                                        onChange={(e) => setSettings((s) => ({ ...s, storageDir: e.target.value }))} />
                                </Field>
                            </div>
                            <p className="mt-3 text-xs text-muted-foreground">留空表示默认位置。只影响新上传的素材，已有素材仍可从原位置读取；保存时会自动创建目录并校验可写。</p>
                            {settings.storageDir && <Button size="small" className="mt-2" disabled={busy} onClick={() => setSettings((s) => ({ ...s, storageDir: null }))}>恢复默认位置</Button>}
                        </section>
                        <section className="rounded-xl border border-border bg-card p-5">
                            <div className="flex items-center gap-2.5">
                                <span className="grid size-8 place-items-center rounded-lg bg-amber-500/10 text-amber-600 dark:text-amber-400"><Scissors className="size-4" /></span>
                                <h2 className="text-sm font-semibold tracking-tight">剪映工程导出位置</h2>
                            </div>
                            <div className="mt-4">
                                <Field label="导出目录（留空自动检测剪映草稿目录）">
                                    <Space.Compact className="w-full"><Input value={settings.jianyingDir ?? ""} disabled={busy} placeholder="自动检测剪映草稿目录"
                                        onChange={(e) => setSettings((s) => ({ ...s, jianyingDir: e.target.value }))} />
                                        <Button disabled={busy} onClick={() => void pickFolder()}>浏览…</Button></Space.Compact>
                                </Field>
                            </div>
                            <p className="mt-3 text-xs text-muted-foreground">留空时自动检测剪映专业版的 Projects 目录并直接写入；填写绝对路径则固定导出到该目录，保存时会自动创建目录并校验可写。若目录不在剪映 Projects 下，需在剪映里通过"导入草稿"打开。</p>
                            {settings.jianyingDir && <Button size="small" className="mt-2" disabled={busy} onClick={() => setSettings((s) => ({ ...s, jianyingDir: null }))}>恢复自动检测</Button>}
                        </section>
                        <div className="flex flex-wrap items-center gap-2">
                            <Button type="primary" disabled={!valid} loading={busy} onClick={() => void act(() => saveAutoVideoSettings(settings), "配置已保存")}>保存配置</Button>
                            <Button disabled={busy || !valid || !settings.visionModel} onClick={() => void act(async () => { await saveAutoVideoSettings(settings); await semanticApi("/admin/settings/test-vision", {}); }, "视觉连接测试通过")}>保存并测试视觉能力</Button>
                            <Button disabled={busy} onClick={() => void act(() => semanticApi("/admin/settings/reindex", {}), "已按当前已保存模型排队重建索引")}>重建已标注素材索引</Button>
                            <Button disabled={busy} icon={<RefreshCw className="size-4" />} onClick={() => void load()}>刷新渠道</Button>
                        </div>
                        <div className="flex items-center gap-2 pb-4">
                            <span className="text-xs text-muted-foreground">视觉测试状态</span>
                            {settings.visionVerified
                                ? <StatusBadge tone="success" label="已通过（更换渠道配置后需重测）" />
                                : <StatusBadge tone="warning" label="待测试" />}
                        </div>
                    </div>
                )}
            </div>
        </main>
    );
}

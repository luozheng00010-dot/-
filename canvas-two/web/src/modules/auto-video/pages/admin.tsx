import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Alert, App, Button, Card, Input, Select, Space, Spin } from "antd";
import { useAuthStore } from "@/stores/use-auth-store";
import { getAutoVideoSettings, saveAutoVideoSettings, type AutoVideoModelChannel, type AutoVideoModelSettings } from "../api";
import { semanticApi } from "../semantic-api";

const groups = [
    { title: "文案／匹配模型", channel: "channelId", model: "model", help: "理解原文、拆解画面需求，并判断候选素材是否有对应证据。" },
    { title: "视觉分析模型", channel: "visionChannelId", model: "visionModel", help: "分析按时间顺序抽取的画面。请选择支持图片输入的文字模型，可与文案模型相同。" },
    { title: "向量模型", channel: "embedChannelId", model: "embedModel", help: "请选择支持 embeddings 接口的模型；更换模型后需要重建素材索引。" },
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
    const valid = groups.every((g, i) => (i > 0 && !settings[g.channel] && !settings[g.model]) || channels.find((c) => c.id === settings[g.channel])?.models.includes(settings[g.model] ?? ""));
    async function act(task: () => Promise<unknown>, success: string) {
        setBusy(true);
        try { await task(); message.success(success); await load(); }
        catch (e) { message.error(e instanceof Error ? e.message : "操作失败"); }
        finally { setBusy(false); }
    }
    if (!admin) return <Alert type="warning" title="仅管理员可以管理自动剪辑模型" />;
    return <main className="h-full overflow-auto p-6"><div className="mb-4 flex justify-between"><h1>自动剪辑管理</h1><Link to="/auto-video">返回工作台</Link></div>
        {error && <Alert type="error" title={error} />}
        {loading ? <Spin /> : <div className="mx-auto flex max-w-3xl flex-col gap-4">
            <Alert type="info" title="复用主站渠道，密钥仅保留在主服务" description="支持 OpenAI 兼容接口。向量模型请在主站文字模型列表登记；视觉理解模型不能使用生图模型替代。已有素材不会自动消耗分析额度。" />
            {groups.map((g) => <Card key={g.model} title={g.title} size="small"><div className="flex flex-col gap-3">
                <Select placeholder="选择主站渠道" value={settings[g.channel] ?? undefined} disabled={busy} options={channels.map((c) => ({ value: c.id, label: c.name }))}
                    onChange={(value) => setSettings((s) => ({ ...s, [g.channel]: value, [g.model]: null }))} />
                <Select showSearch placeholder="选择模型" value={settings[g.model] ?? undefined} disabled={busy || !settings[g.channel]} options={channels.find((c) => c.id === settings[g.channel])?.models.map((m) => ({ value: m, label: m }))}
                    onChange={(value) => setSettings((s) => ({ ...s, [g.model]: value }))} />
                <p className="text-sm text-muted-foreground">{g.help}</p>
            </div></Card>)}
            <Card title="素材存储位置" size="small"><div className="flex flex-col gap-3">
                <Input value={settings.storageDir ?? ""} disabled={busy} placeholder={settings.storageDefaultDir ?? "storage/local_videos"}
                    onChange={(e) => setSettings((s) => ({ ...s, storageDir: e.target.value }))} />
                <p className="text-sm text-muted-foreground">填写剪辑引擎所在机器的绝对路径（如 D:\素材\产品视频），留空表示默认位置。只影响新上传的素材，已有素材仍可从原位置读取；保存时会自动创建目录并校验可写。</p>
                {settings.storageDir && <Button size="small" className="self-start" disabled={busy} onClick={() => setSettings((s) => ({ ...s, storageDir: null }))}>恢复默认位置</Button>}
            </div></Card>
            <Space wrap><Button type="primary" disabled={!valid} loading={busy} onClick={() => void act(() => saveAutoVideoSettings(settings), "配置已保存")}>保存配置</Button>
                <Button disabled={busy || !valid || !settings.visionModel} onClick={() => void act(async () => { await saveAutoVideoSettings(settings); await semanticApi("/admin/settings/test-vision", {}); }, "视觉连接测试通过")}>保存并测试视觉能力</Button>
                <Button disabled={busy} onClick={() => void act(() => semanticApi("/admin/settings/reindex", {}), "已按当前已保存模型排队重建索引")}>重建已标注素材索引</Button>
                <Button disabled={busy} onClick={() => void load()}>刷新渠道</Button></Space>
            <p className="text-sm">视觉测试状态：{settings.visionVerified ? "已通过（更换渠道配置后需重测）" : "待测试"}</p>
        </div>}
    </main>;
}

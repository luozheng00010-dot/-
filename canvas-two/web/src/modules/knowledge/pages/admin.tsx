import { useCallback, useEffect, useState } from "react";
import { App, Button, Empty, Input, InputNumber, Popconfirm, Select, Table, Tabs } from "antd";
import { FileText, FolderCog, LayoutDashboard, MessageSquare, MessagesSquare, Settings2, ThumbsDown, ThumbsUp, Trash2 } from "lucide-react";
import { Field } from "@/components/ui/form-section";
import { PageHeader } from "@/components/ui/page-header";
import { StatTile } from "@/components/ui/stat-tile";
import { StatusBadge } from "@/components/ui/status-badge";
import { createKbCategory, deleteKbCategory, getKbAdminSettings, getKbAdminStats, listKbCategories, updateKbAdminSettings, updateKbCategory } from "../api";
import type { KbCategory, KbChannelOption, KbSettings, KbStats } from "../types";

function SettingsTab() {
    const { message } = App.useApp();
    const [settings, setSettings] = useState<KbSettings | null>(null);
    const [channels, setChannels] = useState<KbChannelOption[]>([]);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        getKbAdminSettings()
            .then((result) => {
                setSettings(result.settings);
                setChannels(result.channels);
            })
            .catch((error) => message.error(error instanceof Error ? error.message : "加载配置失败"));
    }, [message]);

    const save = async () => {
        if (!settings) return;
        setSaving(true);
        try {
            const result = await updateKbAdminSettings({
                chatChannelId: settings.chatChannelId || null,
                chatModel: settings.chatModel || null,
                embedChannelId: settings.embedChannelId || null,
                embedModel: settings.embedModel || null,
                dailyLimitPerUser: settings.dailyLimitPerUser,
            });
            setSettings(result.settings);
            message.success("配置已保存");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "保存失败");
        } finally {
            setSaving(false);
        }
    };

    const channelOptions = channels.map((item) => ({ value: item.id, label: `${item.name}（${item.apiFormat}）` }));
    const modelOptions = (channelId: string | null) => channels.find((item) => item.id === channelId)?.models.map((name) => ({ value: name, label: name })) || [];

    if (!settings) return <Empty description="加载中…" />;
    return (
        <section className="rounded-xl border border-border bg-card p-5">
            <h2 className="text-sm font-semibold tracking-tight">模型配置</h2>
            <div className="mt-4 grid max-w-2xl gap-4 sm:grid-cols-2">
                <Field label="对话模型渠道">
                    <Select
                        className="w-full"
                        allowClear
                        placeholder="自动选择"
                        options={channelOptions}
                        value={settings.chatChannelId}
                        onChange={(value) => setSettings((current) => current && { ...current, chatChannelId: value || null, chatModel: null })}
                    />
                </Field>
                <Field label="对话模型">
                    <Select
                        className="w-full"
                        allowClear
                        placeholder="自动选择"
                        options={modelOptions(settings.chatChannelId)}
                        value={settings.chatModel}
                        onChange={(value) => setSettings((current) => current && { ...current, chatModel: value || null })}
                    />
                </Field>
                <Field label="向量模型渠道">
                    <Select
                        className="w-full"
                        allowClear
                        placeholder="自动选择"
                        options={channelOptions}
                        value={settings.embedChannelId}
                        onChange={(value) => setSettings((current) => current && { ...current, embedChannelId: value || null, embedModel: null })}
                    />
                </Field>
                <Field label="向量模型">
                    <Select
                        className="w-full"
                        allowClear
                        placeholder="自动选择"
                        options={modelOptions(settings.embedChannelId)}
                        value={settings.embedModel}
                        onChange={(value) => setSettings((current) => current && { ...current, embedModel: value || null })}
                    />
                </Field>
                <Field label="每日提问上限">
                    <div className="flex items-center gap-2">
                        <InputNumber
                            min={0}
                            max={1000}
                            value={settings.dailyLimitPerUser}
                            onChange={(value) => setSettings((current) => current && { ...current, dailyLimitPerUser: value ?? 50 })}
                        />
                        <span className="text-xs text-muted-foreground">每人每天可提问次数，0 为不限</span>
                    </div>
                </Field>
            </div>
            <Button type="primary" loading={saving} onClick={() => void save()} className="mt-4">保存配置</Button>
            <p className="mt-3 text-xs text-muted-foreground">留空则自动挑选第一个启用的 OpenAI 兼容渠道（向量模型优先匹配名称含 embed 的模型）。Gemini 格式渠道暂不支持。</p>
        </section>
    );
}

function CategoriesTab() {
    const { message } = App.useApp();
    const [categories, setCategories] = useState<KbCategory[]>([]);
    const [name, setName] = useState("");

    const load = useCallback(() => {
        listKbCategories().then((result) => setCategories(result.categories)).catch(() => undefined);
    }, []);
    useEffect(() => { load(); }, [load]);

    const add = async () => {
        if (!name.trim()) return;
        try {
            await createKbCategory({ name: name.trim(), sort: categories.length });
            setName("");
            load();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "添加失败");
        }
    };

    const rename = async (item: KbCategory) => {
        try {
            await updateKbCategory(item.id, { name: item.name });
            load();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "保存失败");
        }
    };

    const remove = async (item: KbCategory) => {
        try {
            await deleteKbCategory(item.id);
            load();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "删除失败");
        }
    };

    return (
        <section className="rounded-xl border border-border bg-card p-5">
            <h2 className="text-sm font-semibold tracking-tight">分类管理</h2>
            <div className="mb-4 mt-4 flex max-w-md gap-2">
                <Input placeholder="新分类名称" value={name} onChange={(event) => setName(event.target.value)} onPressEnter={() => void add()} />
                <Button type="primary" onClick={() => void add()}>添加</Button>
            </div>
            <Table<KbCategory>
                rowKey="id"
                size="small"
                dataSource={categories}
                pagination={false}
                columns={[
                    {
                        title: "名称",
                        dataIndex: "name",
                        render: (value: string, record) => <Input defaultValue={value} className="max-w-56" onBlur={(event) => { if (event.target.value.trim() && event.target.value !== value) void rename({ ...record, name: event.target.value.trim() }); }} />,
                    },
                    { title: "帖子数", dataIndex: "postCount", width: 100 },
                    {
                        title: "操作",
                        width: 100,
                        render: (_, record) => (
                            <Popconfirm title="删除后该分类下的帖子变为未分类，确认？" onConfirm={() => void remove(record)}>
                                <Button size="small" type="text" danger icon={<Trash2 className="size-3.5" />} />
                            </Popconfirm>
                        ),
                    },
                ]}
            />
        </section>
    );
}

function StatsTab() {
    const { message } = App.useApp();
    const [stats, setStats] = useState<KbStats | null>(null);

    useEffect(() => {
        getKbAdminStats()
            .then(setStats)
            .catch((error) => message.error(error instanceof Error ? error.message : "加载统计失败"));
    }, [message]);

    if (!stats) return <Empty description="加载中…" />;
    const postTotal = stats.postsByStatus.reduce((sum, item) => sum + item._count, 0);
    const published = stats.postsByStatus.find((item) => item.status === "published")?._count || 0;
    return (
        <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
                <StatTile label="帖子总数" value={postTotal} icon={FileText} />
                <StatTile label="已发布" value={published} icon={FileText} tone="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" />
                <StatTile label="向量片段" value={stats.chunks} icon={LayoutDashboard} />
                <StatTile label="AI 会话" value={stats.conversations} icon={MessageSquare} />
                <StatTile label="回答消息" value={stats.messages} icon={MessagesSquare} />
            </div>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
                <StatTile label="答案有用" value={stats.feedback.useful} icon={ThumbsUp} tone="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" />
                <StatTile label="答案无用" value={stats.feedback.useless} icon={ThumbsDown} tone="bg-red-500/10 text-red-600 dark:text-red-400" />
                <StatTile label="零命中回答" value={stats.zeroHitAnswers} icon={MessageSquare} tone="bg-amber-500/10 text-amber-600 dark:text-amber-400" />
            </div>
            {!!stats.indexFailures.length && (
                <section className="rounded-xl border border-border bg-card p-5">
                    <h2 className="text-sm font-semibold tracking-tight">索引失败的帖子</h2>
                    <ul className="mt-3 space-y-2">
                        {stats.indexFailures.map((item) => (
                            <li key={item.id} className="flex flex-wrap items-center gap-2 text-sm">
                                <StatusBadge tone="error" label="失败" />
                                <span className="min-w-0 truncate">{item.title}</span>
                                <span className="text-xs text-muted-foreground">{item.indexError}</span>
                            </li>
                        ))}
                    </ul>
                </section>
            )}
        </div>
    );
}

export default function KnowledgeAdminPage() {
    return (
        <main className="flex h-full flex-col overflow-y-auto bg-background text-foreground">
            <PageHeader
                icon={Settings2}
                tone="bg-violet-500/10 text-violet-600 dark:text-violet-400"
                title="知识库管理"
                description="模型渠道、分类与运营统计（仅管理员可见）"
            />
            <div className="mx-auto w-full max-w-5xl flex-1 px-6 py-5">
                <Tabs
                    items={[
                        { key: "settings", label: "模型配置", icon: <Settings2 className="size-4" />, children: <SettingsTab /> },
                        { key: "categories", label: "分类管理", icon: <FolderCog className="size-4" />, children: <CategoriesTab /> },
                        { key: "stats", label: "数据统计", icon: <LayoutDashboard className="size-4" />, children: <StatsTab /> },
                    ]}
                />
            </div>
        </main>
    );
}

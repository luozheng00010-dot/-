import { useCallback, useEffect, useState } from "react";
import { App, Button, Card, Col, Descriptions, Empty, Input, InputNumber, Popconfirm, Row, Select, Statistic, Table, Tabs, Tag } from "antd";
import { FolderCog, LayoutDashboard, Settings2, Trash2 } from "lucide-react";
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
        <Card size="small" title="模型配置">
            <Descriptions column={1} className="max-w-2xl">
                <Descriptions.Item label="对话模型渠道">
                    <Select
                        className="w-72"
                        allowClear
                        placeholder="自动选择"
                        options={channelOptions}
                        value={settings.chatChannelId}
                        onChange={(value) => setSettings((current) => current && { ...current, chatChannelId: value || null, chatModel: null })}
                    />
                </Descriptions.Item>
                <Descriptions.Item label="对话模型">
                    <Select
                        className="w-72"
                        allowClear
                        placeholder="自动选择"
                        options={modelOptions(settings.chatChannelId)}
                        value={settings.chatModel}
                        onChange={(value) => setSettings((current) => current && { ...current, chatModel: value || null })}
                    />
                </Descriptions.Item>
                <Descriptions.Item label="向量模型渠道">
                    <Select
                        className="w-72"
                        allowClear
                        placeholder="自动选择"
                        options={channelOptions}
                        value={settings.embedChannelId}
                        onChange={(value) => setSettings((current) => current && { ...current, embedChannelId: value || null, embedModel: null })}
                    />
                </Descriptions.Item>
                <Descriptions.Item label="向量模型">
                    <Select
                        className="w-72"
                        allowClear
                        placeholder="自动选择"
                        options={modelOptions(settings.embedChannelId)}
                        value={settings.embedModel}
                        onChange={(value) => setSettings((current) => current && { ...current, embedModel: value || null })}
                    />
                </Descriptions.Item>
                <Descriptions.Item label="每日提问上限">
                    <InputNumber
                        min={0}
                        max={1000}
                        value={settings.dailyLimitPerUser}
                        onChange={(value) => setSettings((current) => current && { ...current, dailyLimitPerUser: value ?? 50 })}
                    />
                    <span className="ml-2 text-xs text-muted-foreground">每人每天可提问次数，0 为不限</span>
                </Descriptions.Item>
            </Descriptions>
            <Button type="primary" loading={saving} onClick={() => void save()} className="mt-2">保存配置</Button>
            <p className="mt-3 text-xs text-muted-foreground">留空则自动挑选第一个启用的 OpenAI 兼容渠道（向量模型优先匹配名称含 embed 的模型）。Gemini 格式渠道暂不支持。</p>
        </Card>
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
        <Card size="small" title="分类管理">
            <div className="mb-4 flex max-w-md gap-2">
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
        </Card>
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
            <Row gutter={16}>
                <Col span={5}><Card size="small"><Statistic title="帖子总数" value={postTotal} /></Card></Col>
                <Col span={5}><Card size="small"><Statistic title="已发布" value={published} /></Card></Col>
                <Col span={5}><Card size="small"><Statistic title="向量片段" value={stats.chunks} /></Card></Col>
                <Col span={4}><Card size="small"><Statistic title="AI 会话" value={stats.conversations} /></Card></Col>
                <Col span={5}><Card size="small"><Statistic title="回答消息" value={stats.messages} /></Card></Col>
            </Row>
            <Row gutter={16}>
                <Col span={5}><Card size="small"><Statistic title="答案有用" value={stats.feedback.useful} valueStyle={{ color: "#3f8600" }} /></Card></Col>
                <Col span={5}><Card size="small"><Statistic title="答案无用" value={stats.feedback.useless} valueStyle={{ color: "#cf1322" }} /></Card></Col>
                <Col span={5}><Card size="small"><Statistic title="零命中回答" value={stats.zeroHitAnswers} /></Card></Col>
            </Row>
            {!!stats.indexFailures.length && (
                <Card size="small" title="索引失败的帖子">
                    <ul className="space-y-1">
                        {stats.indexFailures.map((item) => (
                            <li key={item.id} className="text-sm">
                                <Tag color="red">失败</Tag>
                                {item.title}
                                <span className="ml-2 text-xs text-muted-foreground">{item.indexError}</span>
                            </li>
                        ))}
                    </ul>
                </Card>
            )}
        </div>
    );
}

export default function KnowledgeAdminPage() {
    return (
        <main className="flex h-full flex-col overflow-y-auto bg-background text-foreground">
            <header className="flex items-center gap-3 border-b border-border px-6 py-4">
                <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                    <Settings2 className="size-5" />
                </span>
                <div>
                    <h1 className="text-base font-semibold tracking-tight">知识库管理</h1>
                    <p className="text-xs text-muted-foreground">模型渠道、分类与运营统计（仅管理员可见）</p>
                </div>
            </header>
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

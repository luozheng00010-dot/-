import { useEffect, useState } from "react";
import { App, Button, Card, Descriptions, Empty, Select } from "antd";
import { Settings2 } from "lucide-react";
import { getVideoAdminSettings, updateVideoAdminSettings } from "../api";
import type { VideoChannelOption, VideoSettings } from "../types";

export default function VideoSettingsPage() {
    const { message } = App.useApp();
    const [settings, setSettings] = useState<VideoSettings | null>(null);
    const [channels, setChannels] = useState<VideoChannelOption[]>([]);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        getVideoAdminSettings()
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
            const result = await updateVideoAdminSettings({
                chatChannelId: settings.chatChannelId || null,
                chatModel: settings.chatModel || null,
                visionChannelId: settings.visionChannelId || null,
                visionModel: settings.visionModel || null,
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
        <main className="flex h-full flex-col overflow-y-auto bg-background text-foreground">
            <header className="flex items-center gap-3 border-b border-border px-6 py-4">
                <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                    <Settings2 className="size-5" />
                </span>
                <div>
                    <h1 className="text-base font-semibold tracking-tight">自动剪辑管理</h1>
                    <p className="text-xs text-muted-foreground">模型渠道配置（仅管理员可用）</p>
                </div>
            </header>
            <div className="mx-auto w-full max-w-5xl flex-1 px-6 py-5">
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
                            <span className="ml-2 text-xs text-muted-foreground">用于文案拆句与画面匹配</span>
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
                        <Descriptions.Item label="视觉模型渠道">
                            <Select
                                className="w-72"
                                allowClear
                                placeholder="自动选择"
                                options={channelOptions}
                                value={settings.visionChannelId}
                                onChange={(value) => setSettings((current) => current && { ...current, visionChannelId: value || null, visionModel: null })}
                            />
                            <span className="ml-2 text-xs text-muted-foreground">用于素材打标</span>
                        </Descriptions.Item>
                        <Descriptions.Item label="视觉模型">
                            <Select
                                className="w-72"
                                allowClear
                                placeholder="自动选择"
                                options={modelOptions(settings.visionChannelId)}
                                value={settings.visionModel}
                                onChange={(value) => setSettings((current) => current && { ...current, visionModel: value || null })}
                            />
                        </Descriptions.Item>
                    </Descriptions>
                    <Button type="primary" loading={saving} onClick={() => void save()} className="mt-2">保存配置</Button>
                    <p className="mt-3 text-xs text-muted-foreground">留空则自动挑选第一个启用的 OpenAI 兼容渠道（视觉模型按名称含 vl/vision/qwen-v 识别）。Gemini 格式渠道暂不支持，渠道本身请在系统“配置与用户偏好”页添加。</p>
                </Card>
            </div>
        </main>
    );
}

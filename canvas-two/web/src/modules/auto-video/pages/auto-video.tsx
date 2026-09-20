import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Clapperboard, LoaderCircle, Sparkles, Upload } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { useAuthStore } from "@/stores/use-auth-store";
import { availableCategories, listLibraryOptions, listLocalVideos, type LibraryOption, type LocalVideo } from "@/services/local-materials";
import { Alert, App, Button, Card, ColorPicker, Empty, Input, InputNumber, Segmented, Select, Slider, Switch, Tag, Typography, Upload as AntUpload } from "antd";

import {
    checkAutoVideoHealth,
    listFonts,
    listMusics,
    listVoices,
    uploadMusic,
    type AutoVideoFileEntry,
    type AutoVideoVoice,
} from "../api";

import { semanticApi, type PlanSummary } from "../semantic-api";

const ASPECT_OPTIONS = [
    { label: "竖屏 9:16", value: "9:16" },
    { label: "横屏 16:9", value: "16:9" },
    { label: "方形 1:1", value: "1:1" },
];
const SUBTITLE_POSITIONS = [
    { label: "底部", value: "bottom" },
    { label: "居中", value: "center" },
    { label: "顶部", value: "top" },
    { label: "自定义", value: "custom" },
];
const DEFAULT_VOICE = "zh-CN-XiaoxiaoNeural";

const planStatusMeta: Record<string, { label: string; color: string }> = {
    queued: { label: "匹配中", color: "processing" },
    ready: { label: "待确认", color: "gold" },
    failed: { label: "失败", color: "red" },
};

function hexOf(color: { toHexString: () => string }) {
    return color.toHexString();
}

export default function AutoVideoPage() {
    const { message } = App.useApp();
    const navigate = useNavigate();
    const planRequest = useRef<{ body: string; id: string } | undefined>(undefined);
    const isAdmin = useAuthStore((state) => state.user?.role === "admin");
    const [health, setHealth] = useState<"up" | "down" | "checking">("checking");
    const [voices, setVoices] = useState<AutoVideoVoice[]>([]);
    const [fonts, setFonts] = useState<string[]>([]);
    const [musics, setMusics] = useState<AutoVideoFileEntry[]>([]);
    const [plans, setPlans] = useState<PlanSummary[]>([]);
    const [localSkus, setLocalSkus] = useState<LibraryOption[]>([]);
    const [localCategories, setLocalCategories] = useState<LibraryOption[]>([]);
    const [localSkuId, setLocalSkuId] = useState<string>();
    const [localCategoryIds, setLocalCategoryIds] = useState<string[]>([]);
    const [localVideos, setLocalVideos] = useState<LocalVideo[]>([]);
    const [localTotal, setLocalTotal] = useState(0);
    const [localPage, setLocalPage] = useState(1);
    const [localLoading, setLocalLoading] = useState(false);
    const [localError, setLocalError] = useState("");
    const [localRevision, setLocalRevision] = useState(0);
    const [submitting, setSubmitting] = useState(false);
    const [uploadingMusic, setUploadingMusic] = useState(false);

    // 基础
    const [videoScript, setVideoScript] = useState("");
    const [videoAspect, setVideoAspect] = useState("9:16");
    const [fitMode, setFitMode] = useState<"cover" | "contain">("cover");
    const [videoCount, setVideoCount] = useState(1);
    // 配音
    const [voiceName, setVoiceName] = useState(DEFAULT_VOICE);
    const [voiceRate, setVoiceRate] = useState(1.0);
    const [voiceVolume, setVoiceVolume] = useState(1.0);
    // 音乐
    const [bgmType, setBgmType] = useState("random");
    const [bgmFile, setBgmFile] = useState("");
    const [bgmVolume, setBgmVolume] = useState(0.2);
    // 字幕
    const [subtitleEnabled, setSubtitleEnabled] = useState(true);
    const [subtitlePosition, setSubtitlePosition] = useState("bottom");
    const [customPosition, setCustomPosition] = useState(70);
    const [fontName, setFontName] = useState("MicrosoftYaHeiBold.ttc");
    const [fontSize, setFontSize] = useState(60);
    const [textForeColor, setTextForeColor] = useState("#FFFFFF");
    const [strokeColor, setStrokeColor] = useState("#000000");
    const [strokeWidth, setStrokeWidth] = useState(1.5);

    const refreshHealth = useCallback(async () => {
        try {
            const result = await checkAutoVideoHealth();
            setHealth(result.status);
        } catch {
            setHealth("down");
        }
    }, []);

    const refreshPlans = useCallback(async () => {
        try {
            const data = await semanticApi<PlanSummary[]>("/plans", undefined, "GET");
            setPlans(Array.isArray(data) ? data.slice(0, 20) : []);
        } catch {
            // 服务未启动等情况静默处理，页面顶部横幅会提示
        }
    }, []);

    useEffect(() => {
        void refreshHealth();
        void refreshPlans();
        void listVoices().then((raw) => {
            const list = (Array.isArray(raw) ? raw : []) as AutoVideoVoice[];
            if (list.length && !list.some((v) => v.name === DEFAULT_VOICE)) setVoiceName(list[0].name);
            setVoices(list);
        }).catch(() => undefined);
        void listFonts().then((list) => {
            const fonts = Array.isArray(list) ? list : [];
            if (fonts.length) setFontName((current) => (fonts.includes(current) ? current : fonts[0]));
        }).catch(() => undefined);
        void listMusics().then((data) => setMusics(data.files ?? [])).catch(() => undefined);
        const healthTimer = window.setInterval(refreshHealth, 15_000);
        const planTimer = window.setInterval(() => void refreshPlans(), 5_000);
        return () => {
            window.clearInterval(healthTimer);
            window.clearInterval(planTimer);
        };
    }, [refreshHealth, refreshPlans]);

    useEffect(() => {
        let active = true;
        void listLibraryOptions("skus").then((items) => { if (active) setLocalSkus(items); })
            .catch((error) => { if (active) setLocalError(error instanceof Error ? error.message : "货号加载失败"); });
        return () => { active = false; };
    }, [localRevision]);
    useEffect(() => {
        if (!localSkuId) return;
        let active = true;
        void availableCategories(localSkuId).then((items) => {
            if (!active) return;
            setLocalCategories(items);
            setLocalCategoryIds((ids) => {
                const valid = ids.filter((id) => items.some((item) => item.id === id));
                return valid.length === ids.length ? ids : valid;
            });
        }).catch((error) => { if (active) setLocalError(error instanceof Error ? error.message : "分类加载失败"); });
        return () => { active = false; };
    }, [localSkuId, localRevision]);
    useEffect(() => {
        setLocalVideos([]); setLocalTotal(0); setLocalError("");
        if (!localSkuId || !localCategoryIds.length) { setLocalLoading(false); return; }
        const controller = new AbortController();
        setLocalLoading(true);
        void listLocalVideos({ skuId: localSkuId, categoryIds: localCategoryIds, page: localPage, pageSize: 20 }, controller.signal)
            .then((data) => { if (controller.signal.aborted) return; setLocalVideos(data.items); setLocalTotal(data.total); if (localPage > 1 && !data.items.length) setLocalPage(1); })
            .catch((error) => { if (!controller.signal.aborted) setLocalError(error instanceof Error ? error.message : "素材加载失败"); })
            .finally(() => { if (!controller.signal.aborted) setLocalLoading(false); });
        return () => controller.abort();
    }, [localSkuId, localCategoryIds, localPage, localRevision]);

    const voiceOptions = useMemo(
        () => voices.map((voice) => ({ label: `${voice.name}${voice.gender === "Male" ? " · 男" : voice.gender === "Female" ? " · 女" : ""}`, value: voice.name })),
        [voices],
    );

    const onUploadMusic = async (file: File) => {
        setUploadingMusic(true);
        try {
            await uploadMusic(file);
            const data = await listMusics();
            setMusics(data.files ?? []);
            message.success("背景音乐已上传");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "背景音乐上传失败");
        } finally {
            setUploadingMusic(false);
        }
    };

    const onSubmit = async () => {
        if (submitting) return;
        if (!videoScript.trim()) { message.warning("请粘贴最终文案，匹配时不会改写或删句"); return; }
        if (bgmType === "custom" && !bgmFile) {
            message.warning("请选择背景音乐文件");
            return;
        }
        if (!localSkuId || !localCategoryIds.length || !localTotal || localLoading || localError) {
            message.warning("请选择货号和分类，确认有可用视频后生成");
            return;
        }
        setSubmitting(true);
        try {
            const input = { script: videoScript, skuId: localSkuId, categoryIds: localCategoryIds, count: videoCount, voiceName, voiceRate,
                options: { video_aspect: videoAspect, video_fit_mode: fitMode, subtitle_enabled: subtitleEnabled, subtitle_position: subtitlePosition,
                    font_name: fontName, font_size: fontSize, text_fore_color: textForeColor, stroke_color: strokeColor, stroke_width: strokeWidth,
                    custom_position: customPosition, voice_volume: voiceVolume, bgm_type: bgmType || "none", bgm_file: bgmFile.split(/[\\/]/).pop() || "", bgm_volume: bgmVolume } };
            const body = JSON.stringify(input);
            if (!planRequest.current || planRequest.current.body !== body) planRequest.current = { body, id: crypto.randomUUID() };
            const plan = await semanticApi<{ id: string }>("/plans", { ...input, requestId: planRequest.current.id });
            navigate(`/auto-video/plans/${plan.id}`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "任务提交失败");
        } finally {
            setSubmitting(false);
        }
    };

    const sectionTitle = (text: string) => <Typography.Text strong className="text-sm">{text}</Typography.Text>;

    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="flex items-center gap-2 border-b px-4 py-2 text-sm font-medium">
                <Clapperboard className="size-4" />
                自动剪辑
                <span className="text-muted-foreground hidden text-xs md:inline">用本地素材库按文案语义匹配画面</span>
                <div className="ml-auto flex items-center gap-2">
                    <Link to="/auto-video/materials" className="text-xs">本地素材库</Link>
                    <Link to="/auto-video/plans" className="text-xs">剪辑方案</Link>
                    {isAdmin && <Link to="/auto-video/admin" className="text-xs">管理设置</Link>}
                    {health === "checking" && <Tag>检测服务中…</Tag>}
                    {health === "up" && <Tag color="green">引擎运行中</Tag>}
                    {health === "down" && <Tag color="red">引擎未启动</Tag>}
                </div>
            </div>

            {health === "down" && (
                <Alert
                    className="mx-4 mt-3"
                    type="warning"
                    showIcon
                    message="自动剪辑引擎未启动"
                    description="在项目根目录执行 npm run dev 或 npm run dev:auto-video 启动引擎后重试。"
                />
            )}

            <div className="flex min-h-0 flex-1 gap-4 overflow-hidden p-4">
                {/* 左侧：方案参数 */}
                <Card size="small" className="w-[420px] shrink-0 overflow-y-auto" styles={{ body: { display: "flex", flexDirection: "column", gap: 14 } }}>
                    {sectionTitle("文案")}
                    <div>
                        <Typography.Text type="secondary" className="mb-1 block text-xs">最终原文（匹配时不会改写或删句）</Typography.Text>
                        <Input.TextArea rows={6} placeholder="粘贴你的成片文案，系统将理解每句话并匹配对应画面" value={videoScript} onChange={(event) => setVideoScript(event.target.value)} />
                    </div>

                    {sectionTitle("素材范围")}
                    <div className="flex flex-col gap-2 rounded-md border border-dashed p-2">
                        <div className="flex items-center justify-between"><Link to="/auto-video/materials">管理本地素材库</Link><Button size="small" onClick={() => setLocalRevision((value) => value + 1)}>刷新</Button></div>
                        <Select placeholder="选择货号（必填）" aria-label="素材货号" showSearch optionFilterProp="label" value={localSkuId} options={localSkus.map((item) => ({ label: item.name, value: item.id }))} onChange={(id) => { setLocalSkuId(id); setLocalCategoryIds([]); setLocalCategories([]); setLocalVideos([]); setLocalTotal(0); setLocalPage(1); }} />
                        <Select mode="multiple" placeholder="选择分类（可多选，必填）" aria-label="素材分类" disabled={!localSkuId} value={localCategoryIds} optionFilterProp="label" options={localCategories.map((item) => ({ label: item.name, value: item.id }))} onChange={(ids) => { setLocalCategoryIds(ids); setLocalTotal(0); setLocalPage(1); }} />
                        <Button size="small" disabled={!localCategories.length} onClick={() => { setLocalCategoryIds(localCategories.map((item) => item.id)); setLocalPage(1); }}>选择该货号全部有素材分类</Button>
                        <Typography.Text type="secondary" className="text-xs">{localLoading ? "加载候选视频…" : `匹配 ${localTotal} 个视频，作为候选池参与剪辑`}</Typography.Text>
                        {localError && <Typography.Text type="danger" className="text-xs">{localError}</Typography.Text>}
                        {!localLoading && localSkuId && localCategoryIds.length > 0 && !localTotal && !localError && <Typography.Text type="secondary" className="text-xs">所选分类下没有视频，请到素材库上传。</Typography.Text>}
                        <div className="max-h-28 overflow-y-auto text-xs">{localVideos.map((item) => <div key={item.id} className="truncate" title={item.fileName}>{item.category.name} · {item.fileName}</div>)}</div>
                        {localTotal > 20 && <div className="flex items-center justify-between"><Button size="small" disabled={localPage === 1 || localLoading} onClick={() => setLocalPage((page) => page - 1)}>上一页</Button><span>{localPage} / {Math.ceil(localTotal / 20)}</span><Button size="small" disabled={localPage * 20 >= localTotal || localLoading} onClick={() => setLocalPage((page) => page + 1)}>下一页</Button></div>}
                    </div>

                    <div>
                        <Typography.Text type="secondary" className="mb-1 block text-xs">画面比例 / 适应方式</Typography.Text>
                        <div className="flex gap-2">
                            <Segmented className="flex-1" options={ASPECT_OPTIONS} value={videoAspect} onChange={(value) => setVideoAspect(value as string)} />
                            <Segmented options={[{ label: "填充", value: "cover" }, { label: "完整", value: "contain" }]} value={fitMode} onChange={(value) => setFitMode(value as "cover" | "contain")} />
                        </div>
                    </div>
                    <div>
                        <Typography.Text type="secondary" className="mb-1 block text-xs">成片数量（同一文案的不同画面编排）</Typography.Text>
                        <InputNumber className="w-full" size="small" min={1} max={5} value={videoCount} onChange={(value) => setVideoCount(value ?? 1)} />
                    </div>

                    {sectionTitle("配音")}
                    <div>
                        <Typography.Text type="secondary" className="mb-1 block text-xs">音色</Typography.Text>
                        <Select className="w-full" size="small" showSearch optionFilterProp="label" options={voiceOptions} value={voiceName} onChange={setVoiceName} notFoundContent="加载中…" />
                    </div>
                    <div>
                        <Typography.Text type="secondary" className="mb-1 block text-xs">语速 {voiceRate.toFixed(1)}x</Typography.Text>
                        <Slider min={0.5} max={2} step={0.1} value={voiceRate} onChange={setVoiceRate} />
                    </div>
                    <div>
                        <Typography.Text type="secondary" className="mb-1 block text-xs">音量 {Math.round(voiceVolume * 100)}%</Typography.Text>
                        <Slider min={0} max={2} step={0.1} value={voiceVolume} onChange={setVoiceVolume} />
                    </div>

                    {sectionTitle("背景音乐")}
                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <Typography.Text type="secondary" className="mb-1 block text-xs">音乐来源</Typography.Text>
                            <Select
                                className="w-full"
                                size="small"
                                value={bgmType}
                                onChange={setBgmType}
                                options={[
                                    { label: "随机", value: "random" },
                                    { label: "无", value: "none" },
                                    { label: "指定曲目", value: "custom" },
                                ]}
                            />
                        </div>
                        {bgmType === "custom" && (
                            <div>
                                <div className="mb-1 flex items-center justify-between">
                                    <Typography.Text type="secondary" className="text-xs">曲目</Typography.Text>
                                    <AntUpload
                                        showUploadList={false}
                                        accept=".mp3,.m4a,.aac,.wav,.flac,.ogg,.opus,.wma"
                                        beforeUpload={(file) => {
                                            void onUploadMusic(file);
                                            return false;
                                        }}
                                    >
                                        <Button size="small" type="text" icon={uploadingMusic ? <LoaderCircle className="size-3 animate-spin" /> : <Upload className="size-3" />} />
                                    </AntUpload>
                                </div>
                                <Select className="w-full" size="small" showSearch optionFilterProp="label" value={bgmFile || undefined} onChange={setBgmFile}
                                    options={musics.map((music) => ({ label: music.name, value: music.file }))} placeholder="选择/上传 BGM" notFoundContent="无曲目" />
                            </div>
                        )}
                    </div>
                    <div>
                        <Typography.Text type="secondary" className="mb-1 block text-xs">音乐音量 {Math.round(bgmVolume * 100)}%</Typography.Text>
                        <Slider min={0} max={1} step={0.05} value={bgmVolume} onChange={setBgmVolume} />
                    </div>

                    {sectionTitle("字幕")}
                    <div className="flex items-center justify-between">
                        <Typography.Text type="secondary" className="text-xs">启用字幕</Typography.Text>
                        <Switch size="small" checked={subtitleEnabled} onChange={(checked) => setSubtitleEnabled(checked)} />
                    </div>
                    <div>
                        <Typography.Text type="secondary" className="mb-1 block text-xs">位置</Typography.Text>
                        <Segmented className="flex-1" size="small" options={SUBTITLE_POSITIONS} value={subtitlePosition} onChange={(value) => setSubtitlePosition(value as string)} disabled={!subtitleEnabled} />
                    </div>
                    {subtitleEnabled && subtitlePosition === "custom" && (
                        <div>
                            <Typography.Text type="secondary" className="mb-1 block text-xs">自定义位置 {customPosition}%</Typography.Text>
                            <Slider min={0} max={100} step={1} value={customPosition} onChange={setCustomPosition} />
                        </div>
                    )}
                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <Typography.Text type="secondary" className="mb-1 block text-xs">字体</Typography.Text>
                            <Select className="w-full" size="small" value={fontName} onChange={setFontName} options={fonts.map((name) => ({ label: name.replace(/\.(ttf|ttc|otf)$/i, ""), value: name }))} disabled={!subtitleEnabled} />
                        </div>
                        <div>
                            <Typography.Text type="secondary" className="mb-1 block text-xs">字号 / 描边宽</Typography.Text>
                            <div className="flex gap-2">
                                <InputNumber className="flex-1" size="small" min={24} max={120} step={4} value={fontSize} onChange={(value) => setFontSize(value ?? 60)} disabled={!subtitleEnabled} />
                                <InputNumber className="flex-1" size="small" min={0} max={4} step={0.5} value={strokeWidth} onChange={(value) => setStrokeWidth(value ?? 1.5)} disabled={!subtitleEnabled} />
                            </div>
                        </div>
                    </div>
                    <div className="flex items-center gap-6">
                        <div className="flex items-center gap-2">
                            <Typography.Text type="secondary" className="text-xs">文字色</Typography.Text>
                            <ColorPicker size="small" value={textForeColor} onChange={(color) => setTextForeColor(hexOf(color))} disabled={!subtitleEnabled} />
                        </div>
                        <div className="flex items-center gap-2">
                            <Typography.Text type="secondary" className="text-xs">描边色</Typography.Text>
                            <ColorPicker size="small" value={strokeColor} onChange={(color) => setStrokeColor(hexOf(color))} disabled={!subtitleEnabled} />
                        </div>
                    </div>

                    <Button type="primary" icon={submitting ? <LoaderCircle className="size-4 animate-spin" /> : <Sparkles className="size-4" />} loading={submitting} disabled={health !== "up" || !localSkuId || !localCategoryIds.length || !localTotal || localLoading || !!localError} onClick={onSubmit}>
                        {health === "up" ? "分析文案并匹配画面" : "等待引擎启动"}
                    </Button>
                </Card>

                {/* 右侧：最近的剪辑方案 */}
                <div className="min-w-0 flex-1 overflow-y-auto pr-1">
                    {plans.length === 0 ? (
                        <Empty className="mt-16" description="还没有剪辑方案，左侧粘贴文案开始匹配画面" />
                    ) : (
                        <div className="flex flex-col gap-3">
                            {plans.map((plan) => {
                                const meta = planStatusMeta[plan.status] ?? { label: plan.status, color: "default" };
                                const script = typeof plan.input?.script === "string" ? plan.input.script : "";
                                return (
                                    <Card key={plan.id} size="small" className="cursor-pointer" onClick={() => navigate(`/auto-video/plans/${plan.id}`)}>
                                        <div className="flex items-center gap-2">
                                            <Tag color={meta.color}>{meta.label}</Tag>
                                            <Typography.Text strong ellipsis className="flex-1">
                                                {script.slice(0, 60) || plan.id.slice(0, 8)}
                                            </Typography.Text>
                                            <Typography.Text type="secondary" className="text-xs">{new Date(plan.createdAt).toLocaleString()}</Typography.Text>
                                        </div>
                                        {plan.error && (
                                            <Typography.Paragraph type="danger" className="mt-2 mb-0 text-xs">{plan.error}</Typography.Paragraph>
                                        )}
                                    </Card>
                                );
                            })}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

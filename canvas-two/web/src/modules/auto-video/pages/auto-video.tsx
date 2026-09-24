import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Clapperboard, Film, FolderOpen, LoaderCircle, Settings2, Sparkles, Upload } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { useAuthStore } from "@/stores/use-auth-store";
import { availableCategories, listLibraryOptions, listLocalVideos, type LibraryOption, type LocalVideo } from "@/services/local-materials";
import { App, Button, ColorPicker, Input, InputNumber, Segmented, Select, Slider, Switch, Upload as AntUpload } from "antd";
import { Field, FormSection } from "@/components/ui/form-section";
import { PageHeader } from "@/components/ui/page-header";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";

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
const TRANSITION_OPTIONS = [
    { label: "无（硬切）", value: "none" },
    { label: "溶解", value: "fade" },
    { label: "左滑", value: "slide_left" },
    { label: "右滑", value: "slide_right" },
    { label: "上滑", value: "slide_up" },
    { label: "左擦除", value: "wipe_left" },
    { label: "圆形展开", value: "circle_open" },
    { label: "径向", value: "radial" },
    { label: "像素化", value: "pixelize" },
    { label: "模糊", value: "hblur" },
    { label: "每段随机", value: "shuffle" },
];
const SUBTITLE_POSITIONS = [
    { label: "底部", value: "bottom" },
    { label: "居中", value: "center" },
    { label: "顶部", value: "top" },
    { label: "自定义", value: "custom" },
];
const DEFAULT_VOICE = "zh-CN-XiaoxiaoNeural";
const AMBER_TONE = "bg-amber-500/10 text-amber-600 dark:text-amber-400";

const planStatusMeta: Record<string, { label: string; tone: StatusTone }> = {
    queued: { label: "匹配中", tone: "processing" },
    ready: { label: "待确认", tone: "warning" },
    failed: { label: "失败", tone: "error" },
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
    const [videoTransition, setVideoTransition] = useState("none");
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
                options: { video_aspect: videoAspect, video_fit_mode: fitMode, video_transition: videoTransition, subtitle_enabled: subtitleEnabled, subtitle_position: subtitlePosition,
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

    const healthBadge =
        health === "checking" ? <StatusBadge tone="muted" label="检测服务中…" pulse /> :
        health === "up" ? <StatusBadge tone="success" label="引擎运行中" /> :
        <StatusBadge tone="error" label="引擎未启动" />;

    return (
        <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
            <PageHeader
                icon={Clapperboard}
                tone={AMBER_TONE}
                title="自动剪辑"
                description="用本地素材库按文案语义匹配画面"
                actions={<>
                    <Link to="/auto-video/materials"><Button type="text" icon={<FolderOpen className="size-4" />}>素材库</Button></Link>
                    <Link to="/auto-video/plans"><Button type="text" icon={<Film className="size-4" />}>剪辑方案</Button></Link>
                    {isAdmin && <Link to="/auto-video/admin"><Button type="text" icon={<Settings2 className="size-4" />}>管理设置</Button></Link>}
                    {healthBadge}
                </>}
            />

            {health === "down" && (
                <div className="border-b border-amber-200 bg-amber-50 px-6 py-2 text-xs text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300">
                    自动剪辑引擎未启动：在项目根目录执行 npm run dev 或 npm run dev:auto-video 启动引擎后重试。
                </div>
            )}

            <div className="flex min-h-0 flex-1">
                {/* 左侧：方案参数 */}
                <aside className="flex w-[440px] shrink-0 flex-col border-r border-border bg-card">
                    <div className="flex-1 space-y-6 overflow-y-auto px-5 py-5">
                        <FormSection step={1} title="文案" description="最终原文，匹配时不会改写或删句">
                            <Input.TextArea rows={6} placeholder="粘贴你的成片文案，系统将理解每句话并匹配对应画面" value={videoScript} onChange={(event) => setVideoScript(event.target.value)} />
                        </FormSection>

                        <FormSection step={2} title="素材范围" description="候选池参与剪辑">
                            <div className="space-y-2.5 rounded-lg border border-dashed border-border p-3">
                                <div className="flex items-center justify-between">
                                    <Link to="/auto-video/materials" className="text-xs hover:text-primary">管理本地素材库</Link>
                                    <Button size="small" type="text" onClick={() => setLocalRevision((value) => value + 1)}>刷新</Button>
                                </div>
                                <Select className="w-full" placeholder="选择货号（必填）" aria-label="素材货号" showSearch optionFilterProp="label" value={localSkuId} options={localSkus.map((item) => ({ label: item.name, value: item.id }))} onChange={(id) => { setLocalSkuId(id); setLocalCategoryIds([]); setLocalCategories([]); setLocalVideos([]); setLocalTotal(0); setLocalPage(1); }} />
                                <Select className="w-full" mode="multiple" placeholder="选择分类（可多选，必填）" aria-label="素材分类" disabled={!localSkuId} value={localCategoryIds} optionFilterProp="label" options={localCategories.map((item) => ({ label: item.name, value: item.id }))} onChange={(ids) => { setLocalCategoryIds(ids); setLocalTotal(0); setLocalPage(1); }} />
                                <Button size="small" disabled={!localCategories.length} onClick={() => { setLocalCategoryIds(localCategories.map((item) => item.id)); setLocalPage(1); }}>选择该货号全部有素材分类</Button>
                                <p className="text-xs text-muted-foreground">{localLoading ? "加载候选视频…" : `匹配 ${localTotal} 个视频，作为候选池参与剪辑`}</p>
                                {localError && <p className="text-xs text-red-600 dark:text-red-400">{localError}</p>}
                                {!localLoading && localSkuId && localCategoryIds.length > 0 && !localTotal && !localError && <p className="text-xs text-muted-foreground">所选分类下没有视频，请到素材库上传。</p>}
                                <div className="max-h-28 space-y-1 overflow-y-auto text-xs text-muted-foreground">{localVideos.map((item) => <div key={item.id} className="truncate" title={item.fileName}>{item.category.name} · {item.fileName}</div>)}</div>
                                {localTotal > 20 && (
                                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                                        <Button size="small" disabled={localPage === 1 || localLoading} onClick={() => setLocalPage((page) => page - 1)}>上一页</Button>
                                        <span>{localPage} / {Math.ceil(localTotal / 20)}</span>
                                        <Button size="small" disabled={localPage * 20 >= localTotal || localLoading} onClick={() => setLocalPage((page) => page + 1)}>下一页</Button>
                                    </div>
                                )}
                            </div>
                        </FormSection>

                        <FormSection step={3} title="画面">
                            <Field label="画面比例 / 适应方式">
                                <div className="flex gap-2">
                                    <Segmented className="flex-1" options={ASPECT_OPTIONS} value={videoAspect} onChange={(value) => setVideoAspect(value as string)} />
                                    <Segmented options={[{ label: "填充", value: "cover" }, { label: "完整", value: "contain" }]} value={fitMode} onChange={(value) => setFitMode(value as "cover" | "contain")} />
                                </div>
                            </Field>
                            <Field label="转场特效（镜头拼接处，交叉融合 0.3 秒）">
                                <Select className="w-full" value={videoTransition} options={TRANSITION_OPTIONS} onChange={(value) => setVideoTransition(value)} />
                            </Field>
                            <Field label="成片数量（同一文案的不同画面编排）">
                                <InputNumber className="w-full" min={1} max={5} value={videoCount} onChange={(value) => setVideoCount(value ?? 1)} />
                            </Field>
                        </FormSection>

                        <FormSection step={4} title="配音">
                            <Field label="音色">
                                <Select className="w-full" showSearch optionFilterProp="label" options={voiceOptions} value={voiceName} onChange={setVoiceName} notFoundContent="加载中…" />
                            </Field>
                            <Field label={`语速 ${voiceRate.toFixed(1)}x`}>
                                <Slider min={0.5} max={2} step={0.1} value={voiceRate} onChange={setVoiceRate} />
                            </Field>
                            <Field label={`音量 ${Math.round(voiceVolume * 100)}%`}>
                                <Slider min={0} max={2} step={0.1} value={voiceVolume} onChange={setVoiceVolume} />
                            </Field>
                        </FormSection>

                        <FormSection step={5} title="背景音乐">
                            <div className="grid grid-cols-2 gap-3">
                                <Field label="音乐来源">
                                    <Select
                                        className="w-full"
                                        value={bgmType}
                                        onChange={setBgmType}
                                        options={[
                                            { label: "随机", value: "random" },
                                            { label: "无", value: "none" },
                                            { label: "指定曲目", value: "custom" },
                                        ]}
                                    />
                                </Field>
                                {bgmType === "custom" && (
                                    <Field label="曲目">
                                        <div className="flex gap-1.5">
                                            <Select className="min-w-0 flex-1" showSearch optionFilterProp="label" value={bgmFile || undefined} onChange={setBgmFile}
                                                options={musics.map((music) => ({ label: music.name, value: music.file }))} placeholder="选择/上传 BGM" notFoundContent="无曲目" />
                                            <AntUpload
                                                showUploadList={false}
                                                accept=".mp3,.m4a,.aac,.wav,.flac,.ogg,.opus,.wma"
                                                beforeUpload={(file) => {
                                                    void onUploadMusic(file);
                                                    return false;
                                                }}
                                            >
                                                <Button icon={uploadingMusic ? <LoaderCircle className="size-4 animate-spin" /> : <Upload className="size-4" />} />
                                            </AntUpload>
                                        </div>
                                    </Field>
                                )}
                            </div>
                            <Field label={`音乐音量 ${Math.round(bgmVolume * 100)}%`}>
                                <Slider min={0} max={1} step={0.05} value={bgmVolume} onChange={setBgmVolume} />
                            </Field>
                        </FormSection>

                        <FormSection step={6} title="字幕">
                            <div className="flex items-center justify-between">
                                <span className="text-xs text-muted-foreground">启用字幕</span>
                                <Switch checked={subtitleEnabled} onChange={(checked) => setSubtitleEnabled(checked)} />
                            </div>
                            <Field label="位置">
                                <Segmented className="w-full" options={SUBTITLE_POSITIONS} value={subtitlePosition} onChange={(value) => setSubtitlePosition(value as string)} disabled={!subtitleEnabled} />
                            </Field>
                            {subtitleEnabled && subtitlePosition === "custom" && (
                                <Field label={`自定义位置 ${customPosition}%`}>
                                    <Slider min={0} max={100} step={1} value={customPosition} onChange={setCustomPosition} />
                                </Field>
                            )}
                            <div className="grid grid-cols-2 gap-3">
                                <Field label="字体">
                                    <Select className="w-full" value={fontName} onChange={setFontName} options={fonts.map((name) => ({ label: name.replace(/\.(ttf|ttc|otf)$/i, ""), value: name }))} disabled={!subtitleEnabled} />
                                </Field>
                                <Field label="字号 / 描边宽">
                                    <div className="flex gap-2">
                                        <InputNumber className="flex-1" min={24} max={120} step={4} value={fontSize} onChange={(value) => setFontSize(value ?? 60)} disabled={!subtitleEnabled} />
                                        <InputNumber className="flex-1" min={0} max={4} step={0.5} value={strokeWidth} onChange={(value) => setStrokeWidth(value ?? 1.5)} disabled={!subtitleEnabled} />
                                    </div>
                                </Field>
                            </div>
                            <div className="flex items-center gap-6">
                                <div className="flex items-center gap-2">
                                    <span className="text-xs text-muted-foreground">文字色</span>
                                    <ColorPicker size="small" value={textForeColor} onChange={(color) => setTextForeColor(hexOf(color))} disabled={!subtitleEnabled} />
                                </div>
                                <div className="flex items-center gap-2">
                                    <span className="text-xs text-muted-foreground">描边色</span>
                                    <ColorPicker size="small" value={strokeColor} onChange={(color) => setStrokeColor(hexOf(color))} disabled={!subtitleEnabled} />
                                </div>
                            </div>
                        </FormSection>
                    </div>

                    <footer className="border-t border-border bg-card p-4">
                        <Button type="primary" size="large" block icon={submitting ? <LoaderCircle className="size-4 animate-spin" /> : <Sparkles className="size-4" />} loading={submitting} disabled={health !== "up" || !localSkuId || !localCategoryIds.length || !localTotal || localLoading || !!localError} onClick={onSubmit}>
                            {health === "up" ? "分析文案并匹配画面" : "等待引擎启动"}
                        </Button>
                    </footer>
                </aside>

                {/* 右侧：最近的剪辑方案 */}
                <section className="min-w-0 flex-1 overflow-y-auto px-6 py-5">
                    <div className="mb-4 flex items-center justify-between">
                        <h2 className="text-sm font-semibold tracking-tight">最近的剪辑方案</h2>
                        {plans.length > 0 && <span className="text-xs text-muted-foreground">共 {plans.length} 条</span>}
                    </div>
                    {plans.length === 0 ? (
                        <div className="mt-24 flex flex-col items-center gap-2.5 text-center">
                            <span className={`grid size-12 place-items-center rounded-xl ${AMBER_TONE}`}><Film className="size-6" /></span>
                            <p className="text-sm font-medium">还没有剪辑方案</p>
                            <p className="text-xs text-muted-foreground">左侧粘贴文案，系统将按语义匹配画面</p>
                        </div>
                    ) : (
                        <div className="flex flex-col gap-3">
                            {plans.map((plan) => {
                                const meta = planStatusMeta[plan.status] ?? { label: plan.status, tone: "muted" as StatusTone };
                                const script = typeof plan.input?.script === "string" ? plan.input.script : "";
                                return (
                                    <button key={plan.id} type="button" className="w-full rounded-xl border border-border bg-card p-4 text-left transition hover:border-primary/40 hover:shadow-sm" onClick={() => navigate(`/auto-video/plans/${plan.id}`)}>
                                        <div className="flex items-center gap-2.5">
                                            <StatusBadge tone={meta.tone} label={meta.label} pulse={plan.status === "queued"} />
                                            <span className="min-w-0 flex-1 truncate text-sm font-medium">
                                                {script.slice(0, 60) || plan.id.slice(0, 8)}
                                            </span>
                                            <span className="shrink-0 text-xs text-muted-foreground">{new Date(plan.createdAt).toLocaleString()}</span>
                                        </div>
                                        {plan.error && (
                                            <p className="mt-2 text-xs text-red-600 dark:text-red-400">{plan.error}</p>
                                        )}
                                    </button>
                                );
                            })}
                        </div>
                    )}
                </section>
            </div>
        </div>
    );
}

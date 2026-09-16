import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { App, Button, Input, InputNumber, Select, Spin, Steps, Tag, Tooltip } from "antd";
import { Clapperboard, Film, Plus, Trash2 } from "lucide-react";
import {
    createVideoScript,
    exportVideoTimeline,
    listVideoCategories,
    listVideoMaterials,
    matchVideoScript,
    mediaContentUrl,
    splitVideoScript,
} from "../api";
import SkuSelect from "../components/sku-select";
import type { SentencePlan, VideoCategory, VideoMaterial, VideoTimeline } from "../types";

/** needCategory 色 Tag 的调色板（按分类清单顺序循环取色） */
const CATEGORY_COLORS = ["magenta", "geekblue", "cyan", "purple", "orange", "gold", "blue", "green"];

export default function VideoCreatePage() {
    const { message, modal } = App.useApp();
    const navigate = useNavigate();

    const [categories, setCategories] = useState<VideoCategory[]>([]);
    const [step, setStep] = useState(0);

    // 步骤 1：建文案
    const [title, setTitle] = useState("");
    const [sku, setSku] = useState("");
    const [rawText, setRawText] = useState("");
    const [creating, setCreating] = useState(false);
    const [scriptId, setScriptId] = useState("");

    // 步骤 2：拆句编辑
    const [sentences, setSentences] = useState<SentencePlan[]>([]);
    const [splitting, setSplitting] = useState(false);

    // 步骤 3：只读时间线
    const [timeline, setTimeline] = useState<VideoTimeline | null>(null);
    const [matching, setMatching] = useState(false);
    const [exporting, setExporting] = useState(false);
    const [materialMap, setMaterialMap] = useState<Record<string, VideoMaterial>>({});

    useEffect(() => {
        listVideoCategories()
            .then((result) => setCategories([...result.categories].sort((a, b) => a.sortOrder - b.sortOrder)))
            .catch(() => undefined);
    }, []);

    const categoryColor = useMemo(() => {
        const colorMap: Record<string, string> = {};
        categories.forEach((category, index) => {
            colorMap[category.name] = CATEGORY_COLORS[index % CATEGORY_COLORS.length];
        });
        return (name: string) => colorMap[name] || "default";
    }, [categories]);

    // ===== 步骤 1 → 2 =====

    const createScript = async () => {
        if (!title.trim() || !sku.trim() || !rawText.trim()) {
            message.warning("请填写标题、货号和文案");
            return;
        }
        setCreating(true);
        try {
            const result = await createVideoScript({ title: title.trim(), sku: sku.trim(), rawText: rawText.trim() });
            setScriptId(result.script.id);
            message.success("文案已保存，正在拆句");
            setStep(1);
            await runSplit(result.script.id);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "保存失败");
        } finally {
            setCreating(false);
        }
    };

    // ===== 步骤 2：拆句 =====

    const runSplit = async (id: string) => {
        setSplitting(true);
        try {
            const result = await splitVideoScript(id);
            setSentences(result.script.sentences || []);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "拆句失败，可点击「重新拆句」重试");
        } finally {
            setSplitting(false);
        }
    };

    const confirmResplit = () => {
        modal.confirm({
            title: "重新拆句",
            content: "将按原始文案重新拆句，当前对句子的增删改会被覆盖，确定继续？",
            okText: "重新拆句",
            cancelText: "取消",
            onOk: () => runSplit(scriptId),
        });
    };

    const updateSentence = (sentenceId: number, patch: Partial<SentencePlan>) => {
        setSentences((current) => current.map((item) => (item.sentenceId === sentenceId ? { ...item, ...patch } : item)));
    };

    const removeSentence = (sentenceId: number) => {
        setSentences((current) => current.filter((item) => item.sentenceId !== sentenceId));
    };

    const addSentence = () => {
        setSentences((current) => {
            const nextId = current.reduce((max, item) => Math.max(max, item.sentenceId), 0) + 1;
            return [...current, { sentenceId: nextId, text: "", needCategory: categories[0]?.name || "通用", durationHint: 4, visualNote: "" }];
        });
    };

    // ===== 步骤 2 → 3：匹配 =====

    const generateTimeline = async () => {
        if (!scriptId) return;
        if (!sentences.length) {
            message.warning("至少保留一句文案");
            return;
        }
        if (sentences.some((item) => !item.text.trim())) {
            message.warning("有句子未填写文本");
            return;
        }
        setMatching(true);
        try {
            const payload = sentences.map((item) => ({
                sentenceId: item.sentenceId,
                text: item.text.trim(),
                needCategory: item.needCategory,
                durationHint: item.durationHint,
                visualNote: item.visualNote,
            }));
            const result = await matchVideoScript(scriptId, payload);
            setTimeline(result.timeline);
            setMaterialMap({});
            setStep(2);
            void loadMaterialMap(result.timeline);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "匹配失败");
        } finally {
            setMatching(false);
        }
    };

    /** 收集时间线引用的 materialId，批量拉素材建缩略图映射 */
    const loadMaterialMap = async (target: VideoTimeline) => {
        const ids = Array.from(new Set(target.items.flatMap((item) => item.segments.map((segment) => segment.materialId))));
        if (!ids.length) return;
        try {
            const result = await listVideoMaterials({ ids, page: 1, pageSize: ids.length });
            const map: Record<string, VideoMaterial> = {};
            for (const material of result.items) map[material.id] = material;
            setMaterialMap(map);
        } catch { /* 缩略图加载失败不阻塞展示 */ }
    };

    // ===== 步骤 3：导出 =====

    const submitExport = async () => {
        if (!timeline) return;
        setExporting(true);
        try {
            await exportVideoTimeline(timeline.id);
            message.success("已提交导出任务，正在跳转到导出历史");
            navigate("/video-edit/exports");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "提交导出失败");
        } finally {
            setExporting(false);
        }
    };

    const gapBySentence = useMemo(() => {
        const map: Record<number, NonNullable<VideoTimeline["gapReport"]>["items"][number]> = {};
        for (const gap of timeline?.gapReport?.items || []) map[gap.sentenceId] = gap;
        return map;
    }, [timeline]);

    const totalDuration = useMemo(
        () => (timeline ? timeline.items.reduce((sum, item) => sum + (item.duration || 0), 0) : 0),
        [timeline],
    );

    return (
        <main className="flex h-full flex-col overflow-y-auto bg-background text-foreground">
            <header className="flex flex-wrap items-center gap-3 border-b border-border px-6 py-4">
                <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                    <Clapperboard className="size-5" />
                </span>
                <div className="min-w-0">
                    <h1 className="text-base font-semibold tracking-tight">去创作</h1>
                    <p className="text-xs text-muted-foreground">贴文案 → 拆句分镜 → 自动匹配画面出粗剪</p>
                </div>
                {scriptId && (
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                        {title || "未命名"} · 货号 {sku}
                    </span>
                )}
            </header>

            <div className="border-b border-border px-6 py-4">
                <div className="mx-auto w-full max-w-3xl">
                    <Steps
                        current={step}
                        items={[{ title: "选货号贴文案" }, { title: "拆句分镜" }, { title: "时间线预览" }]}
                    />
                </div>
            </div>

            {step === 0 && (
                <section className="mx-auto w-full max-w-3xl flex-1 px-6 py-6">
                    <div className="space-y-4 rounded-xl border border-border bg-card p-5">
                        <div className="flex flex-wrap items-center gap-3">
                            <Input
                                className="min-w-52 flex-1"
                                placeholder="标题，如：A123 无钢圈文胸种草"
                                value={title}
                                maxLength={120}
                                showCount
                                onChange={(event) => setTitle(event.target.value)}
                            />
                            <SkuSelect
                                className="w-52"
                                placeholder="货号（与素材库一致）"
                                value={sku || null}
                                onChange={(name) => setSku(name ?? "")}
                            />
                        </div>
                        <Input.TextArea
                            rows={12}
                            placeholder="粘贴成片文案，系统将按语义拆成逐句分镜…"
                            value={rawText}
                            maxLength={5000}
                            showCount
                            onChange={(event) => setRawText(event.target.value)}
                        />
                        <div className="flex items-center justify-between">
                            <p className="text-xs text-muted-foreground">拆句时每句会判定所需画面分类与预估时长，进入下一步后可微调。</p>
                            <Button
                                type="primary"
                                loading={creating}
                                disabled={!title.trim() || !sku.trim() || !rawText.trim()}
                                onClick={() => void createScript()}
                            >
                                保存并拆句
                            </Button>
                        </div>
                    </div>
                </section>
            )}

            {step === 1 && (
                <section className="mx-auto w-full max-w-4xl flex-1 px-6 py-6">
                    <Spin spinning={splitting} tip="正在拆句…">
                        <ul className="space-y-3">
                            {sentences.map((sentence) => (
                                <li key={sentence.sentenceId} className="rounded-lg border border-border bg-card px-4 py-3">
                                    <div className="flex items-center gap-2">
                                        <span className="grid size-6 shrink-0 place-items-center rounded-full bg-primary/10 text-xs font-semibold tabular-nums text-primary">
                                            {sentence.sentenceId}
                                        </span>
                                        <span className="text-xs text-muted-foreground">第 {sentence.sentenceId} 句</span>
                                        <Button
                                            size="small"
                                            type="text"
                                            danger
                                            className="ml-auto"
                                            icon={<Trash2 className="size-3.5" />}
                                            onClick={() => removeSentence(sentence.sentenceId)}
                                        >
                                            删句
                                        </Button>
                                    </div>
                                    <Input
                                        className="mt-2"
                                        placeholder="句子文本"
                                        value={sentence.text}
                                        onChange={(event) => updateSentence(sentence.sentenceId, { text: event.target.value })}
                                    />
                                    <div className="mt-2 flex flex-wrap items-center gap-2">
                                        <Select
                                            className="w-36"
                                            placeholder="需要画面分类"
                                            value={sentence.needCategory}
                                            options={categories.map((category) => ({ value: category.name, label: category.name }))}
                                            onChange={(value) => updateSentence(sentence.sentenceId, { needCategory: value })}
                                        />
                                        <InputNumber
                                            className="w-32"
                                            min={0.5}
                                            step={0.5}
                                            addonAfter="s"
                                            value={sentence.durationHint}
                                            onChange={(value) => updateSentence(sentence.sentenceId, { durationHint: typeof value === "number" ? value : 0.5 })}
                                        />
                                        <Input
                                            className="min-w-44 flex-1"
                                            placeholder="画面提示，如：上身侧面贴合"
                                            value={sentence.visualNote}
                                            onChange={(event) => updateSentence(sentence.sentenceId, { visualNote: event.target.value })}
                                        />
                                    </div>
                                </li>
                            ))}
                        </ul>
                        <Button block type="dashed" icon={<Plus className="size-4" />} className="mt-3" onClick={addSentence}>
                            加一句
                        </Button>
                        <div className="mt-4 flex items-center justify-between">
                            <Button onClick={() => setStep(0)}>上一步</Button>
                            <div className="flex items-center gap-2">
                                <Button disabled={splitting || !scriptId} onClick={confirmResplit}>重新拆句</Button>
                                <Button type="primary" loading={matching} disabled={splitting || !sentences.length} onClick={() => void generateTimeline()}>
                                    生成时间线
                                </Button>
                            </div>
                        </div>
                    </Spin>
                </section>
            )}

            {step === 2 && timeline && (
                <section className="mx-auto w-full max-w-4xl flex-1 px-6 py-6">
                    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card px-4 py-2.5 text-xs text-muted-foreground">
                        <span>共 {timeline.items.length} 句</span>
                        <span>缺口 {timeline.gapReport?.items.length || 0} 句</span>
                        <span>总时长 {totalDuration.toFixed(1)}s</span>
                        <span className="ml-auto">缺口句导出时将自动跳过</span>
                    </div>

                    <ul className="mt-3 space-y-3">
                        {timeline.items.map((item) => {
                            const gap = gapBySentence[item.sentenceId];
                            return (
                                <li
                                    key={item.sentenceId}
                                    className={`rounded-lg border bg-card px-4 py-3 ${gap ? "border-red-500/70" : "border-border"}`}
                                >
                                    <div className="flex flex-wrap items-center gap-2">
                                        <span className="grid size-6 shrink-0 place-items-center rounded-full bg-primary/10 text-xs font-semibold tabular-nums text-primary">
                                            {item.sentenceId}
                                        </span>
                                        <span className="min-w-0 flex-1 truncate text-sm font-medium" title={item.subtitle}>{item.subtitle}</span>
                                        <Tag className="mr-0" color={categoryColor(item.needCategory)}>{item.needCategory}</Tag>
                                        <span className="text-xs tabular-nums text-muted-foreground">{item.duration.toFixed(1)}s</span>
                                        {item.downgraded && <Tag className="mr-0" color="orange">降级匹配</Tag>}
                                    </div>
                                    {gap ? (
                                        <p className="mt-2 text-xs leading-5 text-red-600 dark:text-red-400">
                                            缺口：
                                            {gap.kind === "insufficient"
                                                ? `素材时长不足，还差 ${gap.missingSeconds.toFixed(1)} 秒`
                                                : "没有可用素材"}
                                            {gap.detail ? `（${gap.detail}）` : ""}
                                            ，导出时将跳过该句。
                                        </p>
                                    ) : (
                                        <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
                                            {item.segments.map((segment, index) => {
                                                const material = materialMap[segment.materialId];
                                                const segmentDuration = segment.outPoint - segment.inPoint;
                                                return (
                                                    <Tooltip key={`${item.sentenceId}-${index}`} title={segment.reason || "无匹配理由"}>
                                                        <div className="w-24 shrink-0 cursor-help overflow-hidden rounded-md border border-border">
                                                            <div className="relative aspect-[3/4] bg-muted">
                                                                {material?.thumbnailMediaId ? (
                                                                    <img
                                                                        src={mediaContentUrl(material.thumbnailMediaId)}
                                                                        alt={material.fileName}
                                                                        loading="lazy"
                                                                        className="size-full object-cover"
                                                                    />
                                                                ) : (
                                                                    <span className="grid size-full place-items-center text-muted-foreground/40">
                                                                        <Film className="size-5" />
                                                                    </span>
                                                                )}
                                                                <span className="absolute bottom-1 left-1 rounded bg-black/60 px-1 py-0.5 text-xs tabular-nums text-white">
                                                                    {segmentDuration.toFixed(1)}s
                                                                </span>
                                                            </div>
                                                        </div>
                                                    </Tooltip>
                                                );
                                            })}
                                        </div>
                                    )}
                                </li>
                            );
                        })}
                    </ul>

                    <div className="mt-4 flex items-center justify-between">
                        <Button onClick={() => setStep(1)}>返回调整句子</Button>
                        <div className="flex items-center gap-2">
                            <Button disabled={!timeline.id} onClick={() => navigate(`/video-edit/timeline/${timeline.id}`)}>
                                进入编辑器
                            </Button>
                            <Button type="primary" loading={exporting} onClick={() => void submitExport()}>
                                提交导出
                            </Button>
                        </div>
                    </div>
                </section>
            )}
        </main>
    );
}

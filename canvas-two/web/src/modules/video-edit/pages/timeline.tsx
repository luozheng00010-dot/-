import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { App, Button, Drawer, Empty, Input, InputNumber, Modal, Popconfirm, Spin, Tag, Tooltip } from "antd";
import {
    ArrowDown,
    ArrowLeft,
    ArrowRight,
    ArrowUp,
    Clapperboard,
    Film,
    Lock,
    Play,
    Plus,
    RefreshCcw,
    Repeat,
    Save,
    Trash2,
} from "lucide-react";
import {
    exportVideoTimeline,
    getVideoScript,
    getVideoTimeline,
    listVideoCategories,
    listVideoMaterials,
    mediaContentUrl,
    putTimeline,
    rematchTimeline,
} from "../api";
import type { GapItem, TimelineItem, TimelineSegment, VideoCategory, VideoMaterial, VideoScript, VideoTimeline } from "../types";

/**
 * 时间线编辑器（P2 F1）：句级增删调序 + 段级替换/调序/末段裁剪 + 单句重匹配 + 近似预览。
 * 保存走 PUT /timelines/:id 全量覆盖（version+1）；保存前在本地跑与后端同款的校验，
 * 不通过则句卡标红并禁用保存，避免打到服务端才拿到 400。
 */

const GENERAL_SKU = "通用";
const MIN_SEGMENT_SECONDS = 0.5;
const DURATION_TOLERANCE = 0.3;
const EPSILON = 1e-6;
/** 素材批查单页上限（后端 pageSize.max=100），超出分块请求 */
const MATERIAL_BATCH_SIZE = 100;
/** 候选面板一次拉取的素材数（GET /materials?pageSize=100） */
const PICKER_PAGE_SIZE = 100;

/** needCategory 色 Tag 的调色板（按分类清单顺序循环取色），与创作页保持一致 */
const CATEGORY_COLORS = ["magenta", "geekblue", "cyan", "purple", "orange", "gold", "blue", "green"];

const round1 = (value: number) => Math.round(value * 10) / 10;

/** 候选面板的打开目标：segmentIndex=null 表示追加到句尾，否则替换指定段 */
interface PickerTarget {
    sentenceId: number;
    needCategory: string;
    segmentIndex: number | null;
}

/**
 * 与后端 PUT /timelines/:id 同款的前端校验（match.ts collectSegmentViolations +
 * timelineItemSchema 的镜像）：素材 active+done、inPoint=0、0.5≤段长≤素材真实时长、
 * 通用句不得使用货号素材、各段时长和与句子时长差 ≤0.3s。
 * 返回 sentenceId → 违规消息列表，空 Map 表示可保存。
 */
function validateItems(items: TimelineItem[], materialsById: Map<string, VideoMaterial>): Map<number, string[]> {
    const violations = new Map<number, string[]>();
    const push = (sentenceId: number, text: string) => {
        const list = violations.get(sentenceId) || [];
        list.push(text);
        violations.set(sentenceId, list);
    };
    for (const item of items) {
        if (!item.subtitle.trim()) push(item.sentenceId, "字幕不能为空");
        if (item.subtitle.trim().length > 200) push(item.sentenceId, "字幕最长 200 字");
        if (item.duration < MIN_SEGMENT_SECONDS - EPSILON || item.duration > 30 + EPSILON) {
            push(item.sentenceId, "句子时长必须在 0.5 到 30 秒之间");
        }
        if (item.segments.length > 20) push(item.sentenceId, "单句最多 20 段");
        item.segments.forEach((segment, index) => {
            const label = `句子 ${item.sentenceId} 第 ${index + 1} 段`;
            const material = materialsById.get(segment.materialId);
            // 素材批查默认只返回 active 素材，取不到即"已归档/未完成打标"
            if (!material || material.status !== "active" || material.tagStatus !== "done") {
                push(item.sentenceId, `${label}：素材已归档或未完成打标，请替换`);
                return;
            }
            if (Math.abs(segment.inPoint) > EPSILON) {
                push(item.sentenceId, `${label}：起点必须为 0（素材整条使用）`);
                return;
            }
            const length = segment.outPoint - segment.inPoint;
            if (length < MIN_SEGMENT_SECONDS - EPSILON || length > material.duration + EPSILON) {
                push(item.sentenceId, `${label}：段时长必须在 0.5 秒到素材时长（${round1(material.duration)} 秒）之间`);
                return;
            }
            if (item.needCategory === GENERAL_SKU && material.sku !== GENERAL_SKU) {
                push(item.sentenceId, `${label}：通用句不能使用货号 ${material.sku} 的素材`);
            }
        });
        const sum = item.segments.reduce((total, segment) => total + (segment.outPoint - segment.inPoint), 0);
        if (Math.abs(sum - item.duration) > DURATION_TOLERANCE + EPSILON) {
            push(item.sentenceId, `各段总时长（${round1(sum)}s）与句子时长（${round1(item.duration)}s）差值超过 0.3 秒`);
        }
    }
    return violations;
}

export default function VideoTimelinePage() {
    const { message, modal } = App.useApp();
    const navigate = useNavigate();
    const { id = "" } = useParams();

    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState("");
    const [timeline, setTimeline] = useState<VideoTimeline | null>(null);
    const [script, setScript] = useState<VideoScript | null>(null);
    const [items, setItems] = useState<TimelineItem[]>([]);
    const [dirty, setDirty] = useState(false);
    const [materialMap, setMaterialMap] = useState<Record<string, VideoMaterial>>({});
    const [materialLoading, setMaterialLoading] = useState(true);

    const [saving, setSaving] = useState(false);
    const [rematchingId, setRematchingId] = useState<number | null>(null);
    const [exporting, setExporting] = useState(false);

    // 候选面板（替换段 / 追加段共用）
    const [picker, setPicker] = useState<PickerTarget | null>(null);
    const [pickerKeyword, setPickerKeyword] = useState("");
    const [pickerItems, setPickerItems] = useState<VideoMaterial[]>([]);
    const [pickerLoading, setPickerLoading] = useState(false);

    // 近似预览：从第一段开始整条顺序播放
    const [previewOpen, setPreviewOpen] = useState(false);
    const [previewIndex, setPreviewIndex] = useState(0);

    const [categories, setCategories] = useState<VideoCategory[]>([]);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setLoadError("");
        (async () => {
            try {
                const result = await getVideoTimeline(id);
                if (cancelled) return;
                setTimeline(result.timeline);
                setItems(result.timeline.items);
                void ensureMaterials(result.timeline.items);
                try {
                    const scriptResult = await getVideoScript(result.timeline.scriptId);
                    if (!cancelled) setScript(scriptResult.script);
                } catch { /* 文案信息（标题/货号/TTS）加载失败不阻塞编辑 */ }
            } catch (error) {
                if (!cancelled) setLoadError(error instanceof Error ? error.message : "时间线加载失败");
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [id]);

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

    /** 收集时间线引用的 materialId 分块批查（pageSize 上限 100），建 id → 素材映射（缩略图 + 校验用） */
    const ensureMaterials = useCallback(async (target: TimelineItem[]) => {
        const ids = Array.from(new Set(target.flatMap((item) => item.segments.map((segment) => segment.materialId))));
        if (!ids.length) {
            setMaterialLoading(false);
            return;
        }
        setMaterialLoading(true);
        const collected: VideoMaterial[] = [];
        try {
            for (let start = 0; start < ids.length; start += MATERIAL_BATCH_SIZE) {
                const chunk = ids.slice(start, start + MATERIAL_BATCH_SIZE);
                const result = await listVideoMaterials({ ids: chunk, page: 1, pageSize: chunk.length });
                collected.push(...result.items);
            }
            setMaterialMap((current) => {
                const next = { ...current };
                for (const material of collected) next[material.id] = material;
                return next;
            });
        } catch (error) {
            message.error(error instanceof Error ? error.message : "素材信息加载失败");
        } finally {
            setMaterialLoading(false);
        }
    }, [message]);

    /** 用服务端已保存的 timeline 刷新本地状态（保存/重匹配后调用，dirty 清零） */
    const applyTimeline = useCallback((next: VideoTimeline) => {
        setTimeline(next);
        setItems(next.items);
        setDirty(false);
        void ensureMaterials(next.items);
    }, [ensureMaterials]);

    // ===== 本地编辑模型 =====

    const mutate = (updater: (current: TimelineItem[]) => TimelineItem[]) => {
        setItems(updater);
        setDirty(true);
    };

    const updateItem = (sentenceId: number, patch: Partial<TimelineItem>) => {
        mutate((current) => current.map((item) => (item.sentenceId === sentenceId ? { ...item, ...patch } : item)));
    };

    const moveItem = (index: number, offset: -1 | 1) => {
        mutate((current) => {
            const target = index + offset;
            if (target < 0 || target >= current.length) return current;
            const next = [...current];
            [next[index], next[target]] = [next[target], next[index]];
            return next;
        });
    };

    const removeItem = (sentenceId: number) => {
        mutate((current) => current.filter((item) => item.sentenceId !== sentenceId));
    };

    const updateSegment = (sentenceId: number, segmentIndex: number, patch: Partial<TimelineSegment>) => {
        mutate((current) => current.map((item) => (item.sentenceId !== sentenceId ? item : {
            ...item,
            segments: item.segments.map((segment, index) => (index === segmentIndex ? { ...segment, ...patch } : segment)),
        })));
    };

    const moveSegment = (sentenceId: number, segmentIndex: number, offset: -1 | 1) => {
        mutate((current) => current.map((item) => {
            if (item.sentenceId !== sentenceId) return item;
            const target = segmentIndex + offset;
            if (target < 0 || target >= item.segments.length) return item;
            const segments = [...item.segments];
            [segments[segmentIndex], segments[target]] = [segments[target], segments[segmentIndex]];
            return { ...item, segments };
        }));
    };

    const removeSegment = (sentenceId: number, segmentIndex: number) => {
        mutate((current) => current.map((item) => (item.sentenceId !== sentenceId ? item : {
            ...item,
            segments: item.segments.filter((_, index) => index !== segmentIndex),
        })));
    };

    const openPicker = (sentenceId: number, needCategory: string, segmentIndex: number | null) => {
        setPickerKeyword("");
        setPickerItems([]);
        setPicker({ sentenceId, needCategory, segmentIndex });
    };

    /** 候选面板点选：替换指定段或追加到句尾，时长取素材整长（in=0, out=duration），并补进素材映射 */
    const applyMaterial = (material: VideoMaterial) => {
        if (!picker) return;
        const appending = picker.segmentIndex === null;
        const segment: TimelineSegment = {
            materialId: material.id,
            inPoint: 0,
            outPoint: round1(material.duration),
            reason: appending ? "手动添加" : "手动替换",
        };
        mutate((current) => current.map((item) => {
            if (item.sentenceId !== picker.sentenceId) return item;
            const segments = appending
                ? [...item.segments, segment]
                : item.segments.map((entry, index) => (index === picker.segmentIndex ? segment : entry));
            return { ...item, segments };
        }));
        setMaterialMap((current) => ({ ...current, [material.id]: material }));
        setPicker(null);
        message.success(appending ? "已添加段（素材整条使用）" : "已替换素材（素材整条使用）");
    };

    // ===== 校验与保存 =====

    const violations = useMemo(
        () => (materialLoading ? new Map<number, string[]>() : validateItems(items, new Map(Object.entries(materialMap)))),
        [items, materialMap, materialLoading],
    );
    const canSave = !!timeline && dirty && items.length > 0 && violations.size === 0;

    const save = async () => {
        if (!timeline || !canSave) return;
        setSaving(true);
        try {
            const result = await putTimeline(timeline.id, items);
            applyTimeline(result.timeline);
            message.success(`已保存，当前版本 v${result.timeline.version}`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "保存失败");
        } finally {
            setSaving(false);
        }
    };

    const confirmRematch = (item: TimelineItem) => {
        modal.confirm({
            title: `重匹配第 ${item.sentenceId} 句`,
            content: dirty
                ? "将重新为该句挑选素材（消耗一次 AI 匹配）。注意：以服务器已保存的版本为基础，当前未保存的修改会被覆盖，确定继续？"
                : "将重新为该句挑选素材（消耗一次 AI 匹配），其余句子保持不变，确定继续？",
            okText: "重匹配",
            cancelText: "取消",
            onOk: async () => {
                if (!timeline) return;
                setRematchingId(item.sentenceId);
                try {
                    const result = await rematchTimeline(timeline.id, item.sentenceId);
                    applyTimeline(result.timeline);
                    message.success(`已重新匹配第 ${item.sentenceId} 句，当前版本 v${result.timeline.version}`);
                } catch (error) {
                    message.error(error instanceof Error ? error.message : "重匹配失败");
                } finally {
                    setRematchingId(null);
                }
            },
        });
    };

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

    // ===== 候选面板数据 =====

    useEffect(() => {
        if (!picker) return;
        const skuName = script?.sku || "";
        if (picker.needCategory !== GENERAL_SKU && !skuName) return; // 文案信息缺失时无法定位货号，面板里提示
        const sku = picker.needCategory === GENERAL_SKU ? GENERAL_SKU : skuName;
        let cancelled = false;
        setPickerLoading(true);
        (async () => {
            try {
                const result = await listVideoMaterials({
                    sku,
                    status: "active",
                    tagStatus: "done",
                    keyword: pickerKeyword.trim() || undefined,
                    page: 1,
                    pageSize: PICKER_PAGE_SIZE,
                });
                if (!cancelled) setPickerItems(result.items);
            } catch (error) {
                if (!cancelled) {
                    message.error(error instanceof Error ? error.message : "候选素材加载失败");
                    setPickerItems([]);
                }
            } finally {
                if (!cancelled) setPickerLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [picker, pickerKeyword, script, message]);

    /** 分类匹配的候选排在前面（P2 的"匹配度"= 分类一致优先） */
    const sortedPickerItems = useMemo(() => {
        if (!picker) return pickerItems;
        return [...pickerItems].sort((a, b) => {
            const rank = (material: VideoMaterial) => (material.categoryName === picker.needCategory ? 0 : 1);
            return rank(a) - rank(b);
        });
    }, [pickerItems, picker]);

    // ===== 派生数据 =====

    const gapBySentence = useMemo(() => {
        const map: Record<number, GapItem> = {};
        for (const gap of timeline?.gapReport?.items || []) map[gap.sentenceId] = gap;
        return map;
    }, [timeline]);

    const ttsBySentence = useMemo(() => {
        const map: Record<number, number> = {};
        for (const sentence of script?.sentences || []) {
            if (typeof sentence.ttsDuration === "number") map[sentence.sentenceId] = sentence.ttsDuration;
        }
        return map;
    }, [script]);

    const totalDuration = useMemo(() => items.reduce((sum, item) => sum + (item.duration || 0), 0), [items]);

    const previewPlaylist = useMemo(() => {
        if (!previewOpen) return [];
        const list: { mediaFileId: string; subtitle: string }[] = [];
        for (const item of items) {
            for (const segment of item.segments) {
                const material = materialMap[segment.materialId];
                if (material?.mediaFileId) list.push({ mediaFileId: material.mediaFileId, subtitle: item.subtitle });
            }
        }
        return list;
    }, [previewOpen, items, materialMap]);

    const previewCurrent = previewIndex < previewPlaylist.length ? previewPlaylist[previewIndex] : null;
    const hasPlayable = items.some((item) => item.segments.some((segment) => materialMap[segment.materialId]?.mediaFileId));

    const saveHint = !timeline ? ""
        : violations.size ? "存在校验问题，请先修正标红的句子"
        : !items.length ? "至少保留一个句子"
        : !dirty ? "暂无更改"
        : "";
    const exportHint = dirty ? "有未保存更改，请先保存再导出" : violations.size ? "存在校验问题，请先修正" : "";

    // ===== 渲染 =====

    return (
        <main className="flex h-full flex-col overflow-y-auto bg-background text-foreground">
            <header className="flex flex-wrap items-center gap-3 border-b border-border px-6 py-4">
                <Button icon={<ArrowLeft className="size-4" />} onClick={() => navigate("/video-edit/create")}>返回创作页</Button>
                <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                    <Clapperboard className="size-5" />
                </span>
                <div className="min-w-0">
                    <h1 className="flex flex-wrap items-center gap-2 text-base font-semibold tracking-tight">
                        时间线编辑
                        {timeline && <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-normal tabular-nums text-muted-foreground">v{timeline.version}</span>}
                        {dirty && (
                            <span className="inline-flex items-center gap-1 text-xs font-normal text-amber-600 dark:text-amber-400">
                                <span className="size-1.5 rounded-full bg-amber-500" />
                                未保存更改
                            </span>
                        )}
                    </h1>
                    <p className="truncate text-xs text-muted-foreground">
                        {script ? `${script.title} · 货号 ${script.sku}` : "正在加载文案信息…"}
                    </p>
                </div>
                <div className="ml-auto flex shrink-0 items-center gap-2">
                    <Button
                        icon={<Play className="size-4" />}
                        disabled={!hasPlayable}
                        onClick={() => { setPreviewIndex(0); setPreviewOpen(true); }}
                    >
                        预览
                    </Button>
                    <Tooltip title={saveHint}>
                        <span>
                            <Button type="primary" icon={<Save className="size-4" />} loading={saving} disabled={!canSave} onClick={() => void save()}>
                                保存
                            </Button>
                        </span>
                    </Tooltip>
                    <Tooltip title={exportHint}>
                        <span>
                            <Button loading={exporting} disabled={dirty || violations.size > 0} onClick={() => void submitExport()}>
                                提交导出
                            </Button>
                        </span>
                    </Tooltip>
                </div>
            </header>

            {loading ? (
                <div className="flex flex-1 flex-col items-center justify-center gap-3 py-20 text-muted-foreground">
                    <Spin />
                    <span className="text-xs">正在加载时间线…</span>
                </div>
            ) : loadError ? (
                <div className="mx-auto w-full max-w-3xl px-6 py-10">
                    <Empty description={loadError} />
                    <div className="mt-4 text-center">
                        <Button type="primary" onClick={() => navigate("/video-edit/create")}>返回创作页</Button>
                    </div>
                </div>
            ) : timeline ? (
                <section className="mx-auto w-full max-w-5xl flex-1 px-6 py-5">
                    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card px-4 py-2.5 text-xs text-muted-foreground">
                        <span>共 {items.length} 句</span>
                        <span>缺口 {timeline.gapReport?.items.length || 0} 句</span>
                        <span>总时长 {totalDuration.toFixed(1)}s</span>
                        {violations.size > 0 && <span className="text-red-600 dark:text-red-400">校验问题 {violations.size} 句，修正后才能保存</span>}
                        <span className="ml-auto">缺口信息来自最近一次保存/匹配；保存前会按服务端规则校验</span>
                    </div>

                    <ul className="mt-3 space-y-3">
                        {items.map((item, index) => {
                            const gap = gapBySentence[item.sentenceId];
                            const itemViolations = violations.get(item.sentenceId) || [];
                            const ttsDuration = ttsBySentence[item.sentenceId];
                            return (
                                <li
                                    key={item.sentenceId}
                                    className={`rounded-lg border bg-card px-4 py-3 ${gap || itemViolations.length ? "border-red-500/70" : "border-border"}`}
                                >
                                    <div className="flex flex-wrap items-center gap-2">
                                        <span className="grid size-6 shrink-0 place-items-center rounded-full bg-primary/10 text-xs font-semibold tabular-nums text-primary">
                                            {item.sentenceId}
                                        </span>
                                        <Input
                                            className="min-w-48 flex-1"
                                            placeholder="字幕文本"
                                            value={item.subtitle}
                                            maxLength={200}
                                            onChange={(event) => updateItem(item.sentenceId, { subtitle: event.target.value })}
                                        />
                                        <Tag className="mr-0" color={categoryColor(item.needCategory)}>{item.needCategory}</Tag>
                                        {typeof ttsDuration === "number" && <Tag className="mr-0" color="blue">旁白 {ttsDuration.toFixed(1)}s</Tag>}
                                        {item.downgraded && <Tag className="mr-0" color="orange">降级匹配</Tag>}
                                        <InputNumber
                                            className="w-24"
                                            min={0.5}
                                            max={30}
                                            step={0.1}
                                            addonAfter="s"
                                            value={item.duration}
                                            onChange={(value) => updateItem(item.sentenceId, { duration: typeof value === "number" ? value : 0.5 })}
                                        />
                                        <span className="ml-auto flex shrink-0 items-center gap-1">
                                            <Tooltip title="上移">
                                                <Button size="small" type="text" icon={<ArrowUp className="size-3.5" />} disabled={index === 0} onClick={() => moveItem(index, -1)} />
                                            </Tooltip>
                                            <Tooltip title="下移">
                                                <Button size="small" type="text" icon={<ArrowDown className="size-3.5" />} disabled={index === items.length - 1} onClick={() => moveItem(index, 1)} />
                                            </Tooltip>
                                            <Button
                                                size="small"
                                                type="text"
                                                icon={<RefreshCcw className="size-3.5" />}
                                                loading={rematchingId === item.sentenceId}
                                                onClick={() => confirmRematch(item)}
                                            >
                                                重匹配
                                            </Button>
                                            <Popconfirm
                                                title="删除句子"
                                                description="删除后该句不再出现在成片里，确定？"
                                                okText="删除"
                                                cancelText="取消"
                                                okButtonProps={{ danger: true }}
                                                onConfirm={() => removeItem(item.sentenceId)}
                                            >
                                                <Button size="small" type="text" danger icon={<Trash2 className="size-3.5" />} />
                                            </Popconfirm>
                                        </span>
                                    </div>
                                    {gap && (
                                        <p className="mt-2 text-xs leading-5 text-red-600 dark:text-red-400">
                                            缺口：
                                            {gap.kind === "insufficient" ? `素材时长不足，还差 ${gap.missingSeconds.toFixed(1)} 秒` : "没有可用素材"}
                                            {gap.detail ? `（${gap.detail}）` : ""}
                                            ，可在下方手动添加段补救。
                                        </p>
                                    )}
                                    {itemViolations.length > 0 && (
                                        <ul className="mt-2 space-y-1">
                                            {itemViolations.map((text) => (
                                                <li key={text} className="text-xs leading-5 text-red-600 dark:text-red-400">· {text}</li>
                                            ))}
                                        </ul>
                                    )}
                                    <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
                                        {item.segments.map((segment, segmentIndex) => {
                                            const material = materialMap[segment.materialId];
                                            const segmentLength = round1(segment.outPoint - segment.inPoint);
                                            const isLast = segmentIndex === item.segments.length - 1;
                                            return (
                                                <div key={`${item.sentenceId}-${segmentIndex}`} className="flex w-28 shrink-0 flex-col overflow-hidden rounded-md border border-border">
                                                    <Tooltip title={segment.reason || "无匹配理由"}>
                                                        <div className="relative aspect-[3/4] cursor-help bg-muted">
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
                                                            <span className="absolute left-1 top-1 rounded bg-black/60 px-1 text-[10px] tabular-nums text-white">段 {segmentIndex + 1}</span>
                                                            <span className="absolute bottom-1 left-1 rounded bg-black/60 px-1 py-0.5 text-xs tabular-nums text-white">{segmentLength.toFixed(1)}s</span>
                                                        </div>
                                                    </Tooltip>
                                                    <div className="flex flex-1 flex-col gap-1 px-1.5 py-1.5">
                                                        <p className="truncate text-[10px] text-muted-foreground" title={material?.fileName || segment.materialId}>
                                                            {material?.fileName || segment.materialId}
                                                        </p>
                                                        {isLast ? (
                                                            <InputNumber
                                                                size="small"
                                                                className="w-full"
                                                                min={MIN_SEGMENT_SECONDS}
                                                                max={material ? round1(material.duration) : undefined}
                                                                step={0.1}
                                                                value={segmentLength}
                                                                onChange={(value) => updateSegment(item.sentenceId, segmentIndex, {
                                                                    outPoint: round1(segment.inPoint + (typeof value === "number" ? value : MIN_SEGMENT_SECONDS)),
                                                                })}
                                                            />
                                                        ) : (
                                                            <Tooltip title="整条使用，仅末段可裁剪">
                                                                <div className="flex cursor-help items-center justify-center gap-1 rounded border border-dashed border-border px-1 py-0.5 text-[10px] tabular-nums text-muted-foreground">
                                                                    <Lock className="size-3" />
                                                                    {segmentLength.toFixed(1)}s
                                                                </div>
                                                            </Tooltip>
                                                        )}
                                                        <div className="mt-auto flex items-center justify-between">
                                                            <Tooltip title="从候选素材替换">
                                                                <Button
                                                                    size="small"
                                                                    type="text"
                                                                    className="px-1"
                                                                    icon={<Repeat className="size-3.5" />}
                                                                    onClick={() => openPicker(item.sentenceId, item.needCategory, segmentIndex)}
                                                                />
                                                            </Tooltip>
                                                            <span className="flex items-center">
                                                                <Tooltip title="左移">
                                                                    <Button size="small" type="text" className="px-1" icon={<ArrowLeft className="size-3.5" />} disabled={segmentIndex === 0} onClick={() => moveSegment(item.sentenceId, segmentIndex, -1)} />
                                                                </Tooltip>
                                                                <Tooltip title="右移">
                                                                    <Button size="small" type="text" className="px-1" icon={<ArrowRight className="size-3.5" />} disabled={segmentIndex === item.segments.length - 1} onClick={() => moveSegment(item.sentenceId, segmentIndex, 1)} />
                                                                </Tooltip>
                                                            </span>
                                                            <Popconfirm
                                                                title="删除该段"
                                                                description="确定删除这个素材段？"
                                                                okText="删除"
                                                                cancelText="取消"
                                                                okButtonProps={{ danger: true }}
                                                                onConfirm={() => removeSegment(item.sentenceId, segmentIndex)}
                                                            >
                                                                <Button size="small" type="text" danger className="px-1" icon={<Trash2 className="size-3.5" />} />
                                                            </Popconfirm>
                                                        </div>
                                                    </div>
                                                </div>
                                            );
                                        })}
                                        <Button
                                            type="dashed"
                                            className="h-auto min-h-[9rem] w-28 shrink-0"
                                            icon={<Plus className="size-4" />}
                                            onClick={() => openPicker(item.sentenceId, item.needCategory, null)}
                                        >
                                            添加段
                                        </Button>
                                    </div>
                                </li>
                            );
                        })}
                    </ul>
                </section>
            ) : null}

            <Drawer
                title={picker
                    ? picker.segmentIndex === null
                        ? `为第 ${picker.sentenceId} 句添加段`
                        : `替换第 ${picker.sentenceId} 句第 ${picker.segmentIndex + 1} 段`
                    : "挑选素材"}
                open={!!picker}
                onClose={() => setPicker(null)}
                width={620}
            >
                <div className="space-y-3">
                    <Input.Search
                        allowClear
                        enterButton
                        placeholder="按文件名或描述搜索素材"
                        onSearch={(value) => setPickerKeyword(value)}
                    />
                    <p className="text-xs leading-5 text-muted-foreground">
                        {picker?.needCategory === GENERAL_SKU
                            ? "通用句只展示「通用」素材（货号素材会被服务端拒绝）。"
                            : `展示货号「${script?.sku ?? "…"}」的可用素材，分类匹配的排在前面；点选后整条使用（in=0，out=素材时长）。`}
                    </p>
                    {picker && picker.needCategory !== GENERAL_SKU && !script?.sku && (
                        <p className="text-xs text-red-600 dark:text-red-400">文案信息加载失败，无法确定货号，请刷新页面后重试。</p>
                    )}
                    <Spin spinning={pickerLoading}>
                        {!pickerLoading && !sortedPickerItems.length ? (
                            <Empty description="没有符合条件的候选素材" className="py-10" />
                        ) : (
                            <ul className="grid grid-cols-3 gap-3">
                                {sortedPickerItems.map((material) => {
                                    const matched = picker ? material.categoryName === picker.needCategory : true;
                                    return (
                                        <li key={material.id}>
                                            <button
                                                type="button"
                                                className="w-full overflow-hidden rounded-lg border border-border bg-card text-left transition hover:border-primary/60"
                                                onClick={() => applyMaterial(material)}
                                            >
                                                <div className="relative aspect-[3/4] bg-muted">
                                                    {material.thumbnailMediaId ? (
                                                        <img
                                                            src={mediaContentUrl(material.thumbnailMediaId)}
                                                            alt={material.fileName}
                                                            loading="lazy"
                                                            className="size-full object-cover"
                                                        />
                                                    ) : (
                                                        <span className="grid size-full place-items-center text-muted-foreground/40">
                                                            <Film className="size-6" />
                                                        </span>
                                                    )}
                                                    <span className="absolute bottom-1 left-1 rounded bg-black/60 px-1 py-0.5 text-xs tabular-nums text-white">
                                                        {material.duration.toFixed(1)}s
                                                    </span>
                                                </div>
                                                <div className="space-y-1 px-2 py-1.5">
                                                    <Tag className="mr-0 max-w-full truncate" color={matched ? "green" : "gold"}>
                                                        {matched ? "分类匹配" : "降级候选"}
                                                    </Tag>
                                                    <p className="truncate text-xs font-medium" title={material.fileName}>{material.fileName}</p>
                                                    {material.description && (
                                                        <p className="line-clamp-2 text-[10px] leading-4 text-muted-foreground" title={material.description}>
                                                            {material.description}
                                                        </p>
                                                    )}
                                                </div>
                                            </button>
                                        </li>
                                    );
                                })}
                            </ul>
                        )}
                    </Spin>
                </div>
            </Drawer>

            <Modal
                title="时间线预览"
                open={previewOpen}
                onCancel={() => setPreviewOpen(false)}
                footer={null}
                width={440}
            >
                {previewOpen && (previewCurrent ? (
                    <div>
                        <div className="relative overflow-hidden rounded-md bg-black">
                            <video
                                key={previewIndex}
                                controls
                                autoPlay
                                playsInline
                                className="max-h-[70vh] w-full"
                                src={mediaContentUrl(previewCurrent.mediaFileId)}
                                onEnded={() => setPreviewIndex((current) => current + 1)}
                            />
                            <div className="pointer-events-none absolute inset-x-0 top-0 bg-gradient-to-b from-black/70 to-transparent px-3 py-2 text-center text-sm text-white">
                                {previewCurrent.subtitle}
                            </div>
                        </div>
                        <div className="mt-2 text-center text-xs text-muted-foreground">
                            第 {previewIndex + 1} / {previewPlaylist.length} 段 · 近似预览：各段按素材整条顺序播放
                        </div>
                    </div>
                ) : previewPlaylist.length ? (
                    <div className="grid h-56 place-items-center text-sm text-muted-foreground">播放完毕</div>
                ) : (
                    <Empty description="时间线还没有可播放的段" className="py-8" />
                ))}
            </Modal>
        </main>
    );
}

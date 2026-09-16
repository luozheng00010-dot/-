import { z } from "zod";
import { prisma } from "../db.js";
import { chatJson, VideoLlmError } from "./llm.js";
import type { SentencePlan } from "./split.js";

/**
 * 画面匹配（T7，00 文档 §6 匹配流水线 + 01 文档 §4.3/§4.5）：
 * 1) 逐句构建候选池（结构化 SQL，D4）：needCategory=通用 → sku=通用；
 *    其他 → 第一层（货号 X 且分类=needCategory）∪ 第二层降级（货号 X 其他分类，标 downgraded）；
 *    两层全空 → 该句 gap(no_candidate)。
 * 2) chat LLM 按句组合（一段一素材、整条使用、末段裁剪对齐）。
 * 3) 服务端权威校验 + 缺口复核（GapReport 不依赖 LLM 自报）。
 */

export const DURATION_TOLERANCE = 0.3; // 各段时长和与 durationHint 的容差（01 §4.3）
export const MIN_SEGMENT_SECONDS = 0.5; // 单段最短时长
const POOL_FULL_LIMIT = 500; // 超过该数量先按分类过滤（00 §6）
const POOL_TRUNCATED_SIZE = 300; // 仍超则按 useCount 降序截断（00 §6）
const EPSILON = 1e-6;
const GENERAL_SKU = "通用";

const round1 = (value: number) => Math.round(value * 10) / 10;

// ===== 结构定义（00 文档 §5） =====

export interface Segment {
    materialId: string;
    inPoint: number;
    outPoint: number;
    reason: string;
}

export interface TimelineItem {
    sentenceId: number;
    subtitle: string;
    needCategory: string;
    duration: number;
    segments: Segment[];
    downgraded: boolean;
}

export interface GapItem {
    sentenceId: number;
    kind: "no_candidate" | "insufficient";
    needCategory: string;
    detail: string;
    missingSeconds: number;
}

export interface GapReport {
    items: GapItem[];
}

/** 持久化/编辑时间线用的 zod schema（PUT /timelines/:id 复用） */
export const timelineSegmentSchema = z.object({
    materialId: z.string().min(1, "materialId 不能为空"),
    inPoint: z.number().min(0, "inPoint 不能为负数"),
    outPoint: z.number(),
    reason: z.string().trim().max(200, "匹配理由最长 200 字").default(""),
});

export const timelineItemSchema = z.object({
    sentenceId: z.number().int().min(1, "sentenceId 必须是正整数"),
    subtitle: z.string().trim().max(200, "字幕最长 200 字").default(""),
    needCategory: z.string().trim().min(1, "必须有 needCategory").max(30, "分类名最长 30 字"),
    duration: z.number().min(0.5, "句子时长至少 0.5 秒").max(30, "句子时长最长 30 秒"),
    segments: z.array(timelineSegmentSchema).max(20, "单句最多 20 段"),
    downgraded: z.boolean().default(false),
});

// ===== 候选池（00 文档 §6，纯函数便于测试） =====

export interface CandidateMaterial {
    id: string;
    sku: string;
    categoryName: string;
    duration: number;
    description: string | null;
    shotType: string | null;
    motion: string | null;
    useCount: number;
}

export interface PoolMaterial extends CandidateMaterial {
    substitute: boolean; // true=第二层降级候选（同货号其他分类），用于 downgraded 判定
}

export interface SentencePool {
    sentenceId: number;
    needCategory: string;
    materials: PoolMaterial[]; // 第一层在前、降级候选在后
    primaryCount: number;
}

/**
 * 逐句候选池：通用句只用 sku=通用 素材（单层，无降级）；
 * 其他句第一层=货号素材中分类=needCategory，第二层=同货号其他分类（substitute=true）。
 * 两层全空 ⇒ materials 为空数组，由缺口复核判 no_candidate。
 */
export function buildSentencePool(
    sentence: Pick<SentencePlan, "sentenceId" | "needCategory">,
    skuMaterials: CandidateMaterial[],
    generalMaterials: CandidateMaterial[],
): SentencePool {
    if (sentence.needCategory === GENERAL_SKU) {
        const materials = generalMaterials.map((item) => ({ ...item, substitute: false }));
        return { sentenceId: sentence.sentenceId, needCategory: sentence.needCategory, materials, primaryCount: materials.length };
    }
    const primary = skuMaterials.filter((item) => item.categoryName === sentence.needCategory);
    const substitutes = skuMaterials.filter((item) => item.categoryName !== sentence.needCategory);
    return {
        sentenceId: sentence.sentenceId,
        needCategory: sentence.needCategory,
        materials: [
            ...primary.map((item) => ({ ...item, substitute: false })),
            ...substitutes.map((item) => ({ ...item, substitute: true })),
        ],
        primaryCount: primary.length,
    };
}

/** 候选过多时的控制（00 §6）：>500 先按 needCategory 分类过滤，仍超按 useCount 降序取前 300 */
export function capCandidatePool(pool: SentencePool): SentencePool {
    if (pool.materials.length <= POOL_FULL_LIMIT) return pool;
    const byCategory = pool.materials.filter((item) => item.categoryName === pool.needCategory);
    const preferred = byCategory.length ? byCategory : pool.materials;
    // 通用句的候选池是单层（sku=通用），不存在降级标记
    const substituteOf = (item: PoolMaterial) => pool.needCategory !== GENERAL_SKU && item.categoryName !== pool.needCategory;
    if (preferred.length <= POOL_FULL_LIMIT) {
        return { ...pool, materials: preferred.map((item) => ({ ...item, substitute: substituteOf(item) })) };
    }
    const truncated = [...preferred]
        .sort((a, b) => b.useCount - a.useCount)
        .slice(0, POOL_TRUNCATED_SIZE)
        .map((item) => ({ ...item, substitute: substituteOf(item) }));
    return { ...pool, materials: truncated };
}

/** 逐句构建候选池（含数量控制），返回 sentenceId → pool 的映射 */
export function buildCandidatePools(sentences: SentencePlan[], skuMaterials: CandidateMaterial[], generalMaterials: CandidateMaterial[]): Map<number, SentencePool> {
    return new Map(sentences.map((sentence) => {
        const pool = capCandidatePool(buildSentencePool(sentence, skuMaterials, generalMaterials));
        return [sentence.sentenceId, pool];
    }));
}

// ===== LLM 输出 schema 与业务校验（01 §4.3） =====

/** LLM 匹配输出的形状（subtitle/needCategory/duration 由服务端按句子回填） */
export interface MatchLlmItem {
    sentenceId: number;
    segments: Array<{ materialId: string; inPoint: number; outPoint: number; reason: string }>;
    downgraded: boolean;
}

/** LLM 输出的原始形状（可选字段在 normalizeLlmItems 补默认值；不用 zod default 以保持输入输出类型一致） */
const matchLlmItemSchema = z.object({
    sentenceId: z.number().int().min(1),
    segments: z.array(z.object({
        materialId: z.string().min(1),
        inPoint: z.number().min(0).optional(), // 恒为 0，缺省容忍
        outPoint: z.number(),
        reason: z.string().trim().max(200).optional(),
    })),
    downgraded: z.boolean().optional(),
    gap: z.boolean().optional(), // LLM 自报缺口，仅供参考（服务端权威）
});

const matchResultSchema = z.object({ items: z.array(matchLlmItemSchema).min(1, "items 不能为空") });

function normalizeLlmItems(result: z.infer<typeof matchResultSchema>): MatchLlmItem[] {
    return result.items.map((item) => ({
        sentenceId: item.sentenceId,
        downgraded: item.downgraded ?? false,
        segments: item.segments.map((segment) => ({
            materialId: segment.materialId,
            inPoint: segment.inPoint ?? 0,
            outPoint: segment.outPoint,
            reason: segment.reason ?? "",
        })),
    }));
}

export interface SegmentMaterialInfo {
    sku: string;
    duration: number;
    categoryName: string;
}

/**
 * 单段业务校验（01 §4.3，match 与 PUT /timelines 共用）：
 * 素材存在且可用、materialId 在候选池内（allowedMaterialIds 非空时）、inPoint=0、
 * 0.5 ≤ out-in ≤ 素材真实时长、通用句不得使用货号素材。
 */
export function collectSegmentViolations(
    label: string,
    needCategory: string | undefined,
    segments: Array<{ materialId: string; inPoint: number; outPoint: number }>,
    materialsById: Map<string, SegmentMaterialInfo>,
    allowedMaterialIds: Set<string> | null,
): string[] {
    const violations: string[] = [];
    segments.forEach((segment) => {
        const material = materialsById.get(segment.materialId);
        if (!material) {
            violations.push(`${label}：素材 ${segment.materialId} 不存在或已归档/未完成打标`);
            return;
        }
        if (allowedMaterialIds && !allowedMaterialIds.has(segment.materialId)) {
            violations.push(`${label}：素材 ${segment.materialId} 不在该句候选池内`);
            return;
        }
        if (Math.abs(segment.inPoint) > EPSILON) {
            violations.push(`${label}：inPoint 必须为 0（素材整条使用）`);
            return;
        }
        const length = segment.outPoint - segment.inPoint;
        if (length < MIN_SEGMENT_SECONDS - EPSILON || length > material.duration + EPSILON) {
            violations.push(`${label}：段时长必须在 ${MIN_SEGMENT_SECONDS} 秒到素材时长（${round1(material.duration)} 秒）之间`);
            return;
        }
        if (needCategory === GENERAL_SKU && material.sku !== GENERAL_SKU) {
            violations.push(`${label}：通用句不能使用货号 ${material.sku} 的素材`);
        }
    });
    return violations;
}

export interface MatchValidationResult {
    /** 硬错误：重试一次后仍存在则整体失败（502） */
    errors: string[];
    /** 候选池非空但模型没有输出的句子：重试一次后仍缺失则降级为 no_candidate */
    missingSentenceIds: number[];
}

export function validateMatchItems(items: MatchLlmItem[], sentences: SentencePlan[], pools: Map<number, SentencePool>): MatchValidationResult {
    const errors: string[] = [];
    const knownIds = new Set(sentences.map((sentence) => sentence.sentenceId));
    const materialsById = new Map<string, SegmentMaterialInfo>();
    for (const pool of pools.values()) {
        for (const material of pool.materials) {
            materialsById.set(material.id, { sku: material.sku, duration: material.duration, categoryName: material.categoryName });
        }
    }
    const seen = new Set<number>();
    for (const item of items) {
        if (!knownIds.has(item.sentenceId)) {
            errors.push(`未知的 sentenceId：${item.sentenceId}`);
            continue;
        }
        if (seen.has(item.sentenceId)) {
            errors.push(`sentenceId ${item.sentenceId} 重复输出`);
            continue;
        }
        seen.add(item.sentenceId);
        const sentence = sentences.find((entry) => entry.sentenceId === item.sentenceId)!;
        const pool = pools.get(item.sentenceId)!;
        const allowed = new Set(pool.materials.map((material) => material.id));
        item.segments.forEach((segment, index) => {
            errors.push(...collectSegmentViolations(`句子 ${item.sentenceId} 第 ${index + 1} 段`, sentence.needCategory, [segment], materialsById, allowed));
        });
    }
    const missingSentenceIds = sentences
        .filter((sentence) => (pools.get(sentence.sentenceId)?.materials.length ?? 0) > 0 && !seen.has(sentence.sentenceId))
        .map((sentence) => sentence.sentenceId);
    return { errors, missingSentenceIds };
}

// ===== 时长对齐与组装 =====

export function totalSegmentDuration(segments: Array<{ inPoint: number; outPoint: number }>): number {
    return segments.reduce((sum, segment) => sum + (segment.outPoint - segment.inPoint), 0);
}

/**
 * 各段时长和超出 durationHint+0.3 时把最后一段裁剪到刚好补齐（01 §4.3）；
 * 裁完最后一段不足 0.5 秒则尝试去掉最后一段；仍不达标原样返回，交由缺口复核判 insufficient。
 */
export function clampSegmentsToHint(segments: Segment[], durationHint: number): Segment[] {
    const sum = totalSegmentDuration(segments);
    if (sum <= durationHint + DURATION_TOLERANCE + EPSILON) return segments;
    const last = segments[segments.length - 1];
    const previous = sum - (last.outPoint - last.inPoint);
    const target = round1(durationHint - previous);
    if (target >= MIN_SEGMENT_SECONDS) {
        return [...segments.slice(0, -1), { ...last, inPoint: 0, outPoint: round1(last.inPoint + target) }];
    }
    const withoutLast = segments.slice(0, -1);
    return Math.abs(totalSegmentDuration(withoutLast) - durationHint) <= DURATION_TOLERANCE + EPSILON ? withoutLast : segments;
}

/** 把 LLM 输出组装成 TimelineItem[]：回填字幕/分类/时长，downgraded 由服务端按降级层使用情况权威计算 */
export function assembleTimelineItems(sentences: SentencePlan[], pools: Map<number, SentencePool>, llmItems: MatchLlmItem[]): TimelineItem[] {
    const itemsBySentence = new Map(llmItems.map((item) => [item.sentenceId, item]));
    return sentences.map((sentence) => {
        const pool = pools.get(sentence.sentenceId);
        const substituteIds = new Set(pool?.materials.filter((material) => material.substitute).map((material) => material.id) ?? []);
        const rawSegments = itemsBySentence.get(sentence.sentenceId)?.segments ?? [];
        const segments = clampSegmentsToHint(rawSegments.map((segment) => ({ ...segment })), sentence.durationHint);
        return {
            sentenceId: sentence.sentenceId,
            subtitle: sentence.text,
            needCategory: sentence.needCategory,
            duration: sentence.durationHint,
            segments,
            downgraded: segments.some((segment) => substituteIds.has(segment.materialId)),
        };
    });
}

// ===== 缺口复核（01 §4.5，服务端权威） =====

export function buildGapReport(sentences: SentencePlan[], items: TimelineItem[], pools: Map<number, SentencePool>, sku: string): GapReport {
    const itemsBySentence = new Map(items.map((item) => [item.sentenceId, item]));
    const gaps: GapItem[] = [];
    for (const sentence of sentences) {
        const pool = pools.get(sentence.sentenceId);
        const segments = itemsBySentence.get(sentence.sentenceId)?.segments ?? [];
        const hasCandidates = (pool?.materials.length ?? 0) > 0;
        if (!hasCandidates) {
            gaps.push({
                sentenceId: sentence.sentenceId,
                kind: "no_candidate",
                needCategory: sentence.needCategory,
                detail: sentence.needCategory === GENERAL_SKU
                    ? "素材库暂无可用『通用』素材（货号=通用、打标完成）"
                    : `货号 ${sku} 无『${sentence.needCategory}』分类素材，也无同货号其他分类素材可顶替`,
                missingSeconds: 0,
            });
            continue;
        }
        if (!segments.length) {
            gaps.push({
                sentenceId: sentence.sentenceId,
                kind: "no_candidate",
                needCategory: sentence.needCategory,
                detail: "模型未能为该句挑选素材，请重新匹配",
                missingSeconds: 0,
            });
            continue;
        }
        const sum = round1(totalSegmentDuration(segments));
        if (Math.abs(sum - sentence.durationHint) > DURATION_TOLERANCE + EPSILON) {
            const missingSeconds = Math.max(0, round1(sentence.durationHint - sum));
            gaps.push({
                sentenceId: sentence.sentenceId,
                kind: "insufficient",
                needCategory: sentence.needCategory,
                detail: sum < sentence.durationHint
                    ? `货号 ${sku} 可用素材时长不足，还差 ${missingSeconds.toFixed(1)} 秒`
                    : `各段总时长超出预估 ${round1(sum - sentence.durationHint).toFixed(1)} 秒且无法通过裁剪对齐`,
                missingSeconds,
            });
        }
    }
    return { items: gaps };
}

// ===== prompt =====

export const MATCH_SYSTEM_PROMPT = [
    "你是剪辑师。给你：①分镜句列表（含 needCategory / durationHint / visualNote）",
    "②按句分组的候选素材清单（每条：materialId / category=分类 / duration=时长秒 / description=描述 / shotType=景别 / motion=动作 / substitute=是否降级候选）。",
    "为每句挑 1~4 条素材按播放顺序拼满时长，输出 {\"items\":[...]}，每项包含：sentenceId、segments（每段 materialId / inPoint（恒为 0）/ outPoint / reason）、downgraded。",
    "硬规则：",
    "1. needCategory=\"通用\" 的句子只能用清单中分类=\"通用\"的素材；",
    "2. 其他句子优先用\"货号素材且分类=needCategory\"的素材；不够时可用同货号其他分类素材（substitute=true）顶替并标 downgraded=true；",
    "3. 每段素材整条使用（outPoint=该素材时长），只有最后一段允许裁剪来对齐总时长；",
    "4. 各段时长之和与 durationHint 差值 ≤0.3s；候选素材实在不够拼满时该句 segments 留空数组，禁止编造 materialId；",
    "5. 挑选时优先考虑 visualNote 与素材描述的贴合度，写清 reason。",
    "只输出 JSON。",
].join("\n");

/** user 消息：句子列表 + 每句各自的候选池（不把全库素材混塞进同一份清单） */
export function buildMatchUserPrompt(sku: string, sentences: SentencePlan[], pools: Map<number, SentencePool>): string {
    const payload = {
        sku,
        sentences: sentences.map((sentence) => ({
            sentenceId: sentence.sentenceId,
            text: sentence.text,
            needCategory: sentence.needCategory,
            durationHint: sentence.durationHint,
            visualNote: sentence.visualNote,
        })),
        candidatesBySentence: Object.fromEntries(sentences.map((sentence) => [String(sentence.sentenceId), (pools.get(sentence.sentenceId)?.materials ?? []).map((material) => ({
            materialId: material.id,
            category: material.categoryName,
            duration: material.duration,
            description: material.description ?? "",
            shotType: material.shotType ?? "",
            motion: material.motion ?? "",
            substitute: material.substitute,
        }))])),
    };
    return `目标货号：${sku}\n分镜句与每句各自的候选素材清单如下（substitute=true 为降级候选，仅当分类=needCategory 的素材不够拼满时长时使用）：\n${JSON.stringify(payload)}`;
}

const RETRY_PROMPT_SUFFIX = (problems: string) => `\n\n你上一次的输出未通过业务校验，问题如下：\n${problems}\n请修正问题后重新输出完整的 JSON 对象，只输出 JSON。`;

// ===== 主流程 =====

export interface MatchScriptInput {
    sku: string;
    sentences: SentencePlan[];
}

const MATERIAL_SELECT = {
    id: true,
    sku: true,
    duration: true,
    description: true,
    shotType: true,
    motion: true,
    useCount: true,
    category: { select: { name: true } },
} as const;

/** 一次性取匹配范围内的素材（D4）：目标货号 X 的 active+done 素材 + sku=通用 的 active+done 素材。
 *  P2 复核硬闸门（02 §F4）：疑似露产品（productVisible=true）且未人工确认（reviewStatus=none）的
 *  通用素材不进入候选池——这是防串款事故的硬闸门；货号素材不受影响。 */
async function loadPoolMaterials(sku: string, sentences: SentencePlan[]): Promise<[CandidateMaterial[], CandidateMaterial[]]> {
    const needSkuMaterials = sentences.some((sentence) => sentence.needCategory !== GENERAL_SKU);
    const needGeneralMaterials = sentences.some((sentence) => sentence.needCategory === GENERAL_SKU);
    const [skuRows, generalRows] = await Promise.all([
        needSkuMaterials ? prisma.videoMaterial.findMany({ where: { sku, status: "active", tagStatus: "done" }, select: MATERIAL_SELECT }) : [],
        needGeneralMaterials ? prisma.videoMaterial.findMany({ where: { sku: GENERAL_SKU, status: "active", tagStatus: "done", NOT: { productVisible: true, reviewStatus: "none" } }, select: MATERIAL_SELECT }) : [],
    ]);
    const toCandidate = (row: { id: string; sku: string; duration: number; description: string | null; shotType: string | null; motion: string | null; useCount: number; category: { name: string } | null }): CandidateMaterial => ({
        id: row.id,
        sku: row.sku,
        categoryName: row.category?.name ?? "",
        duration: row.duration,
        description: row.description,
        shotType: row.shotType,
        motion: row.motion,
        useCount: row.useCount,
    });
    return [skuRows.map(toCandidate), generalRows.map(toCandidate)];
}

/** LLM 匹配尝试（matchTimeline 与 rematchSentence 共用）：
 *  chatJson（形状校验+内置重试）→ 二轮业务校验（失败把错误拼回再重试一次）；
 *  重试后仍有硬错误则整体 502，重试后仍缺的句子交由缺口复核降级 no_candidate。 */
async function runMatchWithRetry(sku: string, sentences: SentencePlan[], pools: Map<number, SentencePool>): Promise<MatchLlmItem[]> {
    const runAttempt = async (userPrompt: string) => normalizeLlmItems(await chatJson(MATCH_SYSTEM_PROMPT, userPrompt, matchResultSchema));
    const basePrompt = buildMatchUserPrompt(sku, sentences, pools);
    let llmItems = await runAttempt(basePrompt);
    let validation = validateMatchItems(llmItems, sentences, pools);
    if (validation.errors.length || validation.missingSentenceIds.length) {
        const problems = [
            ...validation.errors,
            ...validation.missingSentenceIds.length
                ? [`以下句子缺少匹配结果（候选池非空，请补齐；确实无素材可用时 segments 留空数组）：${validation.missingSentenceIds.join("、")}`]
                : [],
        ];
        llmItems = await runAttempt(basePrompt + RETRY_PROMPT_SUFFIX(problems.join("；")));
        validation = validateMatchItems(llmItems, sentences, pools);
        if (validation.errors.length) {
            throw new VideoLlmError(`匹配结果未通过校验：${validation.errors.join("；")}`);
        }
        // 重试后仍缺的句子：按服务端缺口复核降级为 no_candidate（01 §4.5 服务端权威）
    }
    return llmItems;
}

/**
 * 匹配主流程：候选池 → LLM（含重试）→ 组装 TimelineItem + 服务端权威 GapReport。
 * 所有句子都没有候选时跳过 LLM，直接全部 no_candidate。
 */
export async function matchTimeline(script: MatchScriptInput): Promise<{ items: TimelineItem[]; gapReport: GapReport }> {
    const sentences = script.sentences;
    if (!sentences.length) throw Object.assign(new Error("没有可匹配的句子"), { status: 400 });
    const [skuMaterials, generalMaterials] = await loadPoolMaterials(script.sku, sentences);
    const pools = buildCandidatePools(sentences, skuMaterials, generalMaterials);

    let llmItems: MatchLlmItem[] = [];
    if ([...pools.values()].some((pool) => pool.materials.length > 0)) {
        llmItems = await runMatchWithRetry(script.sku, sentences, pools);
    }

    const items = assembleTimelineItems(sentences, pools, llmItems);
    const gapReport = buildGapReport(sentences, items, pools, script.sku);
    return { items, gapReport };
}

/**
 * 单句重匹配（P2 F1）：只对目标句跑 候选池→LLM→校验→组装，其余句子的 item 原样保留
 * （含人工编辑过的段）；候选池按当前素材状态重建（含露产品硬闸门），最后对整个时间线重算 GapReport。
 * 目标句在当前 items 中不存在时（人工删过该句的段），重匹配结果追加到末尾。
 */
export async function rematchSentence(
    script: MatchScriptInput,
    sentence: SentencePlan,
    currentItems: TimelineItem[],
): Promise<{ items: TimelineItem[]; gapReport: GapReport }> {
    const sentences = script.sentences;
    const [skuMaterials, generalMaterials] = await loadPoolMaterials(script.sku, sentences);
    const pools = buildCandidatePools(sentences, skuMaterials, generalMaterials);
    const pool = pools.get(sentence.sentenceId);
    if (!pool) throw Object.assign(new Error("目标句子不在文案分镜里，请刷新后重试"), { status: 400 });

    // 只把目标句喂给 LLM：候选池映射仅含该句，其他句子的素材不会进入 prompt，也不重跑匹配
    const singlePools = new Map<number, SentencePool>([[sentence.sentenceId, pool]]);
    let llmItems: MatchLlmItem[] = [];
    if (pool.materials.length > 0) {
        llmItems = await runMatchWithRetry(script.sku, [sentence], singlePools);
    }
    const rematched = assembleTimelineItems([sentence], singlePools, llmItems)[0];

    const exists = currentItems.some((item) => item.sentenceId === sentence.sentenceId);
    const items = exists
        ? currentItems.map((item) => item.sentenceId === sentence.sentenceId ? rematched : item)
        : [...currentItems, rematched];
    const gapReport = buildGapReport(sentences, items, pools, script.sku);
    return { items, gapReport };
}

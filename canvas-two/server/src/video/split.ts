import { z } from "zod";
import { prisma } from "../db.js";
import { chatJson } from "./llm.js";

/**
 * 文案拆句（T6，01 文档 §4.2）：
 * chat LLM 把 rawText 拆成 SentencePlan[]，分类清单从数据库动态注入（D11）。
 * needCategory 的数据库存在性校验放进传给 chatJson 的 zod schema（superRefine），
 * 这样 LLM 幻觉出不存在的分类时会先吃到一次带错误说明的重试，仍失败则由
 * chatJson 抛 VideoLlmError（502），用户可看到可理解的中文原因。
 */

/** 单句拆句结果（00 文档 §5，存 VideoScript.sentences） */
const visualNoteField = z.string().trim().max(120, "画面提示最长 120 字");
export const sentencePlanSchema = z.object({
    sentenceId: z.number().int().min(1, "sentenceId 必须是从 1 开始的整数"),
    text: z.string().trim().min(1, "句子文本不能为空").max(200, "单句最长 200 字"),
    needCategory: z.string().trim().min(1, "必须为每句判定 needCategory").max(30, "分类名最长 30 字"),
    durationHint: z.number().min(0.5, "预估时长至少 0.5 秒").max(30, "预估时长最长 30 秒"),
    visualNote: visualNoteField.default(""),
});

export type SentencePlan = z.infer<typeof sentencePlanSchema>;

export const sentencePlanListSchema = z.array(sentencePlanSchema).min(1, "至少要有一句").max(200, "最多 200 句");

/** 数据库分类名清单（按 sortOrder，只取启用分类）：供 prompt 注入与覆盖校验复用。
 *  停用分类（enabled=false，P2 F6 软删）不再参与拆句判定，新建句子不会被判到该分类。 */
export async function loadCategoryNames(): Promise<string[]> {
    const categories = await prisma.videoCategory.findMany({ where: { enabled: true }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] });
    return categories.map((item) => item.name).filter(Boolean);
}

/** 覆盖式编辑的句子列表里出现数据库不存在的分类时，返回中文错误消息；合法返回 null */
export function categoryCheckError(plans: SentencePlan[], categoryNames: string[]): string | null {
    const unknown = [...new Set(plans.map((plan) => plan.needCategory).filter((name) => !categoryNames.includes(name)))];
    if (!unknown.length) return null;
    return `分类不存在：${unknown.join("、")}（可用分类：${categoryNames.join("/") || "无"}）`;
}

/** 01 文档 §4.2 拆句 prompt 骨架，{{categories}} 注入数据库动态分类清单 */
export function buildSplitPrompt(categoryNames: string[]): string {
    const categories = categoryNames.filter(Boolean).join("/") || "通用";
    return [
        "你是短视频文案分镜师。把文案拆成逐句分镜，输出 JSON：{\"sentences\":[SentencePlan]}。",
        "规则：",
        "1. 按语义断句，每句 8~25 字；",
        `2. 为每句判定 needCategory，只能从这些分类中选：${categories}（其中“通用”=不出现产品的画面：穿衣动作、场景氛围、开场结尾）；`,
        "3. 产品卖点句（面料/工艺/版型/上身效果）→ 选产品所属分类；穿搭/氛围/引导句 → 选“通用”；",
        "4. durationHint = 字数 ÷ 4.5，保留 1 位小数；",
        "5. visualNote 用一句话描述理想画面，给后续素材匹配用。",
        "SentencePlan 字段：sentenceId（从 1 开始递增）、text、needCategory、durationHint（秒，0.5~30）、visualNote（不超过 120 字）。",
        "只输出 JSON。",
    ].join("\n");
}

/** chatJson 的结果 schema：结构校验 + needCategory 必须在数据库分类集合内（幻觉分类触发重试）。
 *  注意 visualNote 用 optional 而不是 default（chatJson 的 ZodType<T> 要求输入输出类型一致），缺失在拿到结果后补 ""。 */
const sentencePlanLlmSchema = z.object({
    sentenceId: sentencePlanSchema.shape.sentenceId,
    text: sentencePlanSchema.shape.text,
    needCategory: sentencePlanSchema.shape.needCategory,
    durationHint: sentencePlanSchema.shape.durationHint,
    visualNote: visualNoteField.optional(),
});

export function buildSplitResultSchema(categoryNames: string[]) {
    return z.object({ sentences: z.array(sentencePlanLlmSchema).min(1, "至少要有一句").max(200, "最多 200 句") }).superRefine((data, ctx) => {
        const seen = new Set<number>();
        data.sentences.forEach((plan, index) => {
            if (!categoryNames.includes(plan.needCategory)) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: ["sentences", index, "needCategory"],
                    message: `分类「${plan.needCategory}」不存在，只能从这些分类中选择：${categoryNames.join("/")}`,
                });
            }
            if (seen.has(plan.sentenceId)) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: ["sentences", index, "sentenceId"],
                    message: `sentenceId ${plan.sentenceId} 重复`,
                });
            }
            seen.add(plan.sentenceId);
        });
    });
}

/** 模型输出的 sentenceId 可能从 1 递增上有偏差：按 id 排序后统一重编为 1..n */
export function normalizeSentenceIds(plans: SentencePlan[]): SentencePlan[] {
    return [...plans]
        .sort((a, b) => a.sentenceId - b.sentenceId)
        .map((plan, index) => ({ ...plan, sentenceId: index + 1 }));
}

/** 拆句主流程：动态分类注入 prompt → chatJson（含重试）→ 重编 sentenceId */
export async function splitSentences(rawText: string): Promise<SentencePlan[]> {
    const text = rawText.trim();
    if (!text) throw Object.assign(new Error("文案内容为空，无法拆句"), { status: 400 });
    const categoryNames = await loadCategoryNames();
    if (!categoryNames.length) throw Object.assign(new Error("素材分类未初始化，请联系管理员检查数据库"), { status: 500 });
    const result = await chatJson(buildSplitPrompt(categoryNames), `文案如下：\n${text}`, buildSplitResultSchema(categoryNames));
    return normalizeSentenceIds(result.sentences.map((plan) => ({ ...plan, visualNote: plan.visualNote ?? "" })));
}

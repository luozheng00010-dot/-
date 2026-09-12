import type { AiTextMessage } from "@/services/api/image";
import type { UploadedImage } from "@/services/image-storage";

export type CompetitorReplicationInput = {
    sourceNodeId: string;
    competitorMediaIds: string[];
    instruction: string;
    includeBrand: boolean;
    brandOverride: string;
    includeText: boolean;
    textOverride: string;
    includePackaging: boolean;
};

export type CompetitorReplicationDialogValue = CompetitorReplicationInput & {
    competitorImages: UploadedImage[];
};

export type CompetitorVisualAnalysis = {
    composition: string;
    lighting: string;
    color: string;
    camera: string;
    atmosphere: string;
    visualHierarchy: string;
    generationPrompt: string;
};

const ANALYSIS_FIELDS: Array<keyof CompetitorVisualAnalysis> = ["composition", "lighting", "color", "camera", "atmosphere", "visualHierarchy", "generationPrompt"];

type CompetitorReplicationOptions = Pick<CompetitorReplicationInput, "includeBrand" | "brandOverride" | "includeText" | "textOverride" | "includePackaging">;

export function buildCompetitorAnalysisMessages(images: string[], instruction: string, options: CompetitorReplicationOptions): AiTextMessage[] {
    const content: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> = [
        {
            type: "text",
            text: [
                "你是电商视觉策略分析师。图片 1 是用户自己的商品，图片 2 起是竞品参考图。",
                "请分析竞品可迁移的视觉策略，同时识别用户商品必须保持的外形、颜色、材质、Logo、结构和细节。",
                "只分析构图、留白、镜头角度、景别、视线方向、背景、色彩关系、光线、道具、场景氛围、视觉卖点和信息层级。",
                options.includeBrand
                    ? options.brandOverride.trim()
                        ? `品牌与 Logo：按用户指定的“${options.brandOverride.trim()}”规划，不使用竞品原品牌。`
                        : "品牌与 Logo：识别并允许保留竞品图中清晰可见的原品牌与 Logo，不清晰时不要虚构。"
                    : "品牌与 Logo：不得进入分析结论或生成策略。",
                options.includeText
                    ? options.textOverride.trim()
                        ? `文字：按用户指定的“${options.textOverride.trim()}”规划，不使用竞品原文字。`
                        : "文字：识别并允许保留竞品图中清晰可见的原文字，不清晰时不要虚构。"
                    : "文字：不得进入分析结论或生成策略。",
                options.includePackaging
                    ? "包装与装饰：分析竞品包装结构、图案和装饰表现，并作为可迁移策略。"
                    : "包装与装饰：不得进入分析结论或生成策略。",
                "人物脸、模特身份和水印始终不得复制。",
                instruction.trim() ? `用户补充要求：${instruction.trim()}` : "",
                '只返回 JSON，不要使用 Markdown。格式：{"composition":"...","lighting":"...","color":"...","camera":"...","atmosphere":"...","visualHierarchy":"...","generationPrompt":"..."}',
                "所有字段必须使用中文完整填写。generationPrompt 必须严格遵守以上允许项与禁止项。",
            ].filter(Boolean).join("\n"),
        },
    ];
    images.forEach((image, index) => {
        content.push({ type: "text", text: index === 0 ? "图片 1：我的商品" : `图片 ${index + 1}：竞品参考 ${index}` });
        content.push({ type: "image_url", image_url: { url: image } });
    });
    return [{ role: "user", content }];
}

export function parseCompetitorVisualAnalysis(value: string): CompetitorVisualAnalysis {
    const trimmed = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("视觉分析返回格式不正确，请重新分析或更换支持图片理解的文本模型");

    let parsed: unknown;
    try {
        parsed = JSON.parse(trimmed.slice(start, end + 1));
    } catch {
        throw new Error("视觉分析返回的 JSON 无法解析，请重新分析或更换文本模型");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("视觉分析返回格式不正确，请重新分析或更换文本模型");

    const record = parsed as Record<string, unknown>;
    const analysis = Object.fromEntries(ANALYSIS_FIELDS.map((field) => [field, typeof record[field] === "string" ? record[field].trim() : ""])) as CompetitorVisualAnalysis;
    if (ANALYSIS_FIELDS.some((field) => !analysis[field])) throw new Error("视觉分析缺少必要字段，请重新分析或更换支持图片理解的文本模型");
    return analysis;
}

export function formatCompetitorVisualAnalysis(analysis: CompetitorVisualAnalysis) {
    return [
        `构图与留白\n${analysis.composition}`,
        `光线\n${analysis.lighting}`,
        `色彩关系\n${analysis.color}`,
        `镜头语言\n${analysis.camera}`,
        `背景与氛围\n${analysis.atmosphere}`,
        `视觉卖点与信息层级\n${analysis.visualHierarchy}`,
        `可执行生成策略\n${analysis.generationPrompt}`,
    ].join("\n\n");
}

export function buildCompetitorGenerationPrompt(analysis: CompetitorVisualAnalysis, instruction: string, options: CompetitorReplicationOptions) {
    return [
        "以参考图 1 中用户自己的商品为唯一商品主体，保持其真实外形、颜色、材质、结构、比例和细节，不要把竞品商品替换到画面中。",
        "参考后续竞品图片的视觉策略，迁移构图、留白、视觉层级、光线、色彩关系、背景氛围和镜头语言。",
        `构图策略：${analysis.composition}`,
        `光线策略：${analysis.lighting}`,
        `色彩策略：${analysis.color}`,
        `镜头策略：${analysis.camera}`,
        `氛围策略：${analysis.atmosphere}`,
        `信息层级：${analysis.visualHierarchy}`,
        `执行建议：${analysis.generationPrompt}`,
        options.includeBrand
            ? options.brandOverride.trim()
                ? `品牌与 Logo：使用用户指定的“${options.brandOverride.trim()}”，不要保留竞品原品牌。`
                : "品牌与 Logo：允许保留竞品图中清晰可见的原品牌与 Logo；无法准确识别时不要虚构。"
            : "品牌与 Logo：禁止复制竞品品牌、Logo、商标或其他可识别品牌资产。",
        options.includeText
            ? options.textOverride.trim()
                ? `文字：画面需要使用用户指定的“${options.textOverride.trim()}”，不要保留竞品原文字。`
                : "文字：允许保留竞品图中清晰可识别的原文字；无法准确识别时不要虚构。"
            : "文字：禁止复制竞品文案、标签或其他可见文字，也不要添加未经用户要求的新文字。",
        options.includePackaging
            ? "包装与装饰：允许迁移竞品包装结构、图案和装饰表现，但不得让竞品商品取代用户商品主体。"
            : "包装与装饰：禁止复制竞品独特包装、图案、专属装饰或包装结构。",
        instruction.trim() ? `用户补充要求（不得覆盖商品一致性与安全限制）：${instruction.trim()}` : "",
        "始终禁止复制竞品人物或模特脸、水印，也不要输出与竞品逐像素相同的画面。",
        "最终只输出一张完成度高的电商视觉图片。",
    ].filter(Boolean).join("\n");
}

export function sourceImageRatio(width: number | undefined, height: number | undefined) {
    const rawWidth = Math.max(1, Math.round(width || 1));
    const rawHeight = Math.max(1, Math.round(height || 1));
    const ratio = rawWidth / rawHeight;
    if (ratio >= 3) return "3:1";
    if (ratio <= 1 / 3) return "1:3";
    const normalizedWidth = Math.max(1, Math.round(ratio * 100));
    const divisor = greatestCommonDivisor(normalizedWidth, 100);
    return `${normalizedWidth / divisor}:${100 / divisor}`;
}

function greatestCommonDivisor(a: number, b: number): number {
    return b ? greatestCommonDivisor(b, a % b) : a;
}

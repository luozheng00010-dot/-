/**
 * ASS 字幕生成（纯函数，01 文档 §4.4 第③步的输入）。
 * 规则：
 * - 句起止时间 = 前序（未被跳过的）句 duration 累加；
 *   segments 为空的缺口句不占时间轴、也不出字幕（P1 缺口句直接跳过，D8）。
 * - 每句一条 Dialogue，时长 = 该句 duration。
 * - 样式 P2 起支持 3 套预置（F3a）：PlayRes 1080x1920，Microsoft YaHei，底部居中；
 *   用户自定义样式是 P3 的打磨项。
 */

export interface TimelineSegment {
    materialId: string;
    inPoint: number;
    outPoint: number;
    reason?: string;
}

export interface TimelineItem {
    sentenceId: number;
    subtitle: string;
    needCategory?: string | null;
    duration: number;
    segments: TimelineSegment[];
    downgraded?: boolean;
}

/** 字幕预置样式名（F3a）：极简白 / 强调黄 / 黑底白字条 */
export type SubtitleStyle = "minimal" | "highlight" | "bar";

/** 一套 ASS Style 行的参数（颜色为 ASS 的 &HAABBGGRR 格式，注意是 BGR 顺序） */
export interface SubtitleStyleSpec {
    fontSize: number;
    primaryColour: string;
    outlineColour: string;
    backColour: string;
    borderStyle: 1 | 3;
    outline: number;
    marginV: number;
}

/** 3 套预置字幕样式（字号/颜色/边框沿用 P1 的量级） */
export const SUBTITLE_STYLES: Record<SubtitleStyle, SubtitleStyleSpec> = {
    // P1 现状：白字黑边
    minimal: { fontSize: 64, primaryColour: "&H00FFFFFF", outlineColour: "&H00000000", backColour: "&H00000000", borderStyle: 1, outline: 3, marginV: 220 },
    // 强调黄：金黄色主字（&H0000D7FF = BGR，即 RGB 00D7FF）+ 黑边
    highlight: { fontSize: 68, primaryColour: "&H0000D7FF", outlineColour: "&H00000000", backColour: "&H00000000", borderStyle: 1, outline: 3, marginV: 220 },
    // 黑底白字条：底部半透明黑条（BackColour alpha=80）+ 白字
    bar: { fontSize: 60, primaryColour: "&H00FFFFFF", outlineColour: "&H00000000", backColour: "&H80000000", borderStyle: 3, outline: 3, marginV: 220 },
};

const DEFAULT_PLAY_RES_X = 1080;
const DEFAULT_PLAY_RES_Y = 1920;
const DEFAULT_CHARS_PER_LINE = 16;
const SECONDARY_COLOUR = "&H000000FF";

/** 全角字符判定：CJK 文字/标点、假名、谚文、全角形式等按 1 个全角宽度计，其余按 0.5 */
const FULLWIDTH_PATTERN = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/;

function isFullwidthChar(char: string): boolean {
    return FULLWIDTH_PATTERN.test(char);
}

/**
 * ASS 特殊字符转义：大括号是 override tag 语法且 ASS 没有原生转义序列，
 * 按惯例替换为全角括号，避免字幕文本被 libass 当特效标记吞掉。
 */
export function escapeAssText(text: string): string {
    return text.replace(/\{/g, "｛").replace(/\}/g, "｝");
}

/**
 * 长句折行：累计宽度达到 charsPerLine 个全角字符处插入硬换行 \N（半角按 0.5 宽累计）；
 * 文本里已有的 \N 换行标记保留原位并重置行宽计数。
 */
export function wrapAssText(text: string, charsPerLine: number = DEFAULT_CHARS_PER_LINE): string {
    const chars = Array.from(text);
    let width = 0;
    let wrapped = "";
    for (let index = 0; index < chars.length; index += 1) {
        const char = chars[index];
        if (char === "\\" && chars[index + 1] === "N") {
            wrapped += "\\N";
            index += 1;
            width = 0;
            continue;
        }
        wrapped += char;
        width += isFullwidthChar(char) ? 1 : 0.5;
        if (width >= charsPerLine && index < chars.length - 1) {
            wrapped += "\\N";
            width = 0;
        }
    }
    return wrapped;
}

/** ASS 时间格式 H:MM:SS.CC（厘秒），负值与非数值按 0 处理 */
export function formatAssTime(seconds: number): string {
    const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
    const totalCentiseconds = Math.round(safe * 100);
    const centiseconds = totalCentiseconds % 100;
    const totalSeconds = Math.floor(totalCentiseconds / 100);
    const ss = totalSeconds % 60;
    const mm = Math.floor(totalSeconds / 60) % 60;
    const hh = Math.floor(totalSeconds / 3600);
    return `${hh}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}.${String(centiseconds).padStart(2, "0")}`;
}

/** 字幕文本完整处理：大括号转义 → 换行统一为 \N → 每 16 个全角字符宽度折行 */
export function formatAssText(text: string, charsPerLine: number = DEFAULT_CHARS_PER_LINE): string {
    const normalized = escapeAssText(text).replace(/\r\n?/g, "\\N").replace(/\n/g, "\\N");
    return wrapAssText(normalized, charsPerLine);
}

/** 生成完整 ASS 字幕文件内容（utf-8 写盘后交给 ffmpeg ass 滤镜烧录）；styleName 选 3 套预置之一，默认 minimal */
export function buildAssSubtitle(items: TimelineItem[], styleName: SubtitleStyle = "minimal"): string {
    const style = SUBTITLE_STYLES[styleName] ?? SUBTITLE_STYLES.minimal;
    const charsPerLine = DEFAULT_CHARS_PER_LINE;

    const header = [
        "[Script Info]",
        "ScriptType: v4.00+",
        `PlayResX: ${DEFAULT_PLAY_RES_X}`,
        `PlayResY: ${DEFAULT_PLAY_RES_Y}`,
        "WrapStyle: 0",
        "ScaledBorderAndShadow: yes",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
        `Style: Default,Microsoft YaHei,${style.fontSize},${style.primaryColour},${SECONDARY_COLOUR},${style.outlineColour},${style.backColour},0,0,0,0,100,100,0,0,${style.borderStyle},${style.outline},0,2,10,10,${style.marginV},1`,
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ];

    const dialogues: string[] = [];
    let cursor = 0;
    for (const item of items) {
        if (!item.segments?.length) continue; // 缺口句：不占时间轴、不出字幕
        const start = cursor;
        const duration = Number.isFinite(item.duration) && item.duration > 0 ? item.duration : 0;
        const end = start + duration;
        cursor = end;
        const text = formatAssText(item.subtitle ?? "", charsPerLine);
        dialogues.push(`Dialogue: 0,${formatAssTime(start)},${formatAssTime(end)},Default,,0,0,0,,${text}`);
    }
    return `${header.join("\n")}\n${dialogues.join("\n")}\n`;
}

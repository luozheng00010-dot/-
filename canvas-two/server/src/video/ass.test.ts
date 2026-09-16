import { describe, expect, it } from "vitest";
import { buildAssSubtitle, escapeAssText, formatAssText, formatAssTime, SUBTITLE_STYLES, wrapAssText, type SubtitleStyle, type TimelineItem } from "./ass.js";

const item = (overrides: Partial<TimelineItem>): TimelineItem => ({
    sentenceId: 1,
    subtitle: "字幕文本",
    duration: 1,
    segments: [{ materialId: "material-1", inPoint: 0, outPoint: 1 }],
    ...overrides,
});

function dialogueLines(output: string): string[] {
    return output.split("\n").filter((line) => line.startsWith("Dialogue:"));
}

function styleLineOf(output: string): string {
    const line = output.split("\n").find((entry) => entry.startsWith("Style: "));
    expect(line).toBeDefined();
    return line!;
}

function fieldsOf(styleLine: string): string[] {
    return styleLine.slice("Style: ".length).split(",");
}

function dialogueText(line: string): string {
    // Dialogue 字段：Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text → 前 9 个逗号之后都是 Text
    return line.split(",").slice(9).join(",");
}

describe("formatAssTime", () => {
    it("formats H:MM:SS.CC with centiseconds", () => {
        expect(formatAssTime(0)).toBe("0:00:00.00");
        expect(formatAssTime(4.5)).toBe("0:00:04.50");
        expect(formatAssTime(61.239)).toBe("0:01:01.24");
        expect(formatAssTime(3672.34)).toBe("1:01:12.34");
        expect(formatAssTime(36000)).toBe("10:00:00.00");
    });

    it("clamps negative and invalid values to zero", () => {
        expect(formatAssTime(-3)).toBe("0:00:00.00");
        expect(formatAssTime(Number.NaN)).toBe("0:00:00.00");
        expect(formatAssTime(Number.POSITIVE_INFINITY)).toBe("0:00:00.00");
    });
});

describe("escapeAssText", () => {
    it("replaces halfwidth braces with fullwidth ones (ASS has no brace escape)", () => {
        expect(escapeAssText("a{\\b1}b")).toBe("a｛\\b1｝b");
        expect(escapeAssText("纯文本")).toBe("纯文本");
    });
});

describe("wrapAssText", () => {
    it("inserts a hard break every 16 fullwidth characters", () => {
        const text = "一二三四五六七八九十一二三四五六七八九十"; // 20 个全角字符
        expect(wrapAssText(text)).toBe("一二三四五六七八九十一二三四五六\\N七八九十");
    });

    it("does not append a trailing break for exactly 16 characters", () => {
        const text = "一二三四五六七八九十一二三四五六"; // 16 个
        expect(wrapAssText(text)).toBe(text);
    });

    it("counts halfwidth characters as 0.5 width", () => {
        const text = "a".repeat(40); // 40 半角 = 20 全角宽 → 32 个半角处折行
        expect(wrapAssText(text)).toBe(`${"a".repeat(32)}\\N${"a".repeat(8)}`);
    });

    it("resets the width counter at an existing \\N break", () => {
        const text = "一二三四五六七八\\N一二三四五六七八九十";
        expect(wrapAssText(text)).toBe(text); // 每段都不超过 16，不再额外折行
    });

    it("keeps wrapping long lines after an existing break", () => {
        const text = "x\\N一二三四五六七八九十一二三四五六七八";
        expect(wrapAssText(text)).toBe(`x\\N一二三四五六七八九十一二三四五六\\N七八`);
    });
});

describe("formatAssText", () => {
    it("escapes braces and converts newlines to hard breaks before wrapping", () => {
        expect(formatAssText("第一行\n第二行")).toBe("第一行\\N第二行");
        expect(formatAssText("a{b}c")).toBe("a｛b｝c");
        expect(formatAssText("第一行\r\n第二行")).toBe("第一行\\N第二行");
    });
});

describe("buildAssSubtitle", () => {
    it("accumulates sentence start times from previous durations", () => {
        const output = buildAssSubtitle([
            item({ sentenceId: 1, subtitle: "第一句", duration: 4.5 }),
            item({ sentenceId: 2, subtitle: "第二句", duration: 3.2 }),
        ]);
        const lines = dialogueLines(output);
        expect(lines).toHaveLength(2);
        expect(lines[0]).toContain("0:00:00.00,0:00:04.50");
        expect(lines[0]).toContain(",第一句");
        expect(lines[1]).toContain("0:00:04.50,0:00:07.70");
        expect(lines[1]).toContain(",第二句");
    });

    it("skips gap sentences (empty segments) without occupying the timeline", () => {
        const output = buildAssSubtitle([
            item({ sentenceId: 1, subtitle: "第一句", duration: 4.5 }),
            item({ sentenceId: 2, subtitle: "缺口句", duration: 9.9, segments: [] }),
            item({ sentenceId: 3, subtitle: "第三句", duration: 2.0 }),
        ]);
        const lines = dialogueLines(output);
        expect(lines).toHaveLength(2);
        expect(output).not.toContain("缺口句");
        expect(lines[1]).toContain("0:00:04.50,0:00:06.50");
    });

    it("defaults to the minimal (P1) style header", () => {
        const output = buildAssSubtitle([item({ subtitle: "样式" })]);
        expect(output).toContain("[Script Info]");
        expect(output).toContain("PlayResX: 1080");
        expect(output).toContain("PlayResY: 1920");
        const styleLine = styleLineOf(output);
        expect(fieldsOf(styleLine)[0]).toBe("Default");
        expect(fieldsOf(styleLine)[1]).toBe("Microsoft YaHei");
        expect(fieldsOf(styleLine)[2]).toBe("64"); // FontSize
        expect(fieldsOf(styleLine)[3]).toBe("&H00FFFFFF"); // PrimaryColour 白
        expect(fieldsOf(styleLine)[5]).toBe("&H00000000"); // OutlineColour 黑
        expect(fieldsOf(styleLine)[6]).toBe("&H00000000"); // BackColour
        expect(fieldsOf(styleLine)[7]).toBe("0"); // Bold
        expect(fieldsOf(styleLine)[15]).toBe("1"); // BorderStyle 描边
        expect(fieldsOf(styleLine)[16]).toBe("3"); // Outline
        expect(fieldsOf(styleLine)[18]).toBe("2"); // Alignment 底部居中
        expect(fieldsOf(styleLine)[21]).toBe("220"); // MarginV
    });

    it("renders the highlight style with a golden primary colour and a bigger font", () => {
        const styleLine = styleLineOf(buildAssSubtitle([item({ subtitle: "样式" })], "highlight"));
        const fields = fieldsOf(styleLine);
        expect(fields[2]).toBe("68"); // FontSize
        expect(fields[3]).toBe("&H0000D7FF"); // 金黄（ASS 是 BGR）
        expect(fields[5]).toBe("&H00000000"); // 黑边
        expect(fields[15]).toBe("1");
        expect(fields[21]).toBe("220");
    });

    it("renders the bar style with a translucent black box and white text", () => {
        const styleLine = styleLineOf(buildAssSubtitle([item({ subtitle: "样式" })], "bar"));
        const fields = fieldsOf(styleLine);
        expect(fields[2]).toBe("60"); // FontSize
        expect(fields[3]).toBe("&H00FFFFFF"); // 白字
        expect(fields[6]).toBe("&H80000000"); // 半透明黑条
        expect(fields[15]).toBe("3"); // BorderStyle 不透明底盒
        expect(fields[18]).toBe("2");
        expect(fields[21]).toBe("220");
    });

    it("falls back to minimal for an unknown style name", () => {
        expect(buildAssSubtitle([item({ subtitle: "样式" })], "unknown" as SubtitleStyle)).toBe(buildAssSubtitle([item({ subtitle: "样式" })]));
    });

    it("exposes exactly the three preset style names", () => {
        expect(Object.keys(SUBTITLE_STYLES).sort()).toEqual(["bar", "highlight", "minimal"]);
    });

    it("emits one Dialogue per sentence with wrapped long text", () => {
        const subtitle = "这款无钢圈文胸久穿不勒，面料轻薄透气，一整天都舒服"; // 25 个全角字符
        const output = buildAssSubtitle([item({ sentenceId: 1, subtitle, duration: 6 })]);
        const lines = dialogueLines(output);
        expect(lines).toHaveLength(1);
        expect(dialogueText(lines[0])).toBe(`${subtitle.slice(0, 16)}\\N${subtitle.slice(16)}`);
        expect(lines[0]).toContain("0:00:00.00,0:00:06.00");
    });

    it("escapes braces inside dialogue text so libass will not treat them as override tags", () => {
        const output = buildAssSubtitle([item({ subtitle: "买它{强推}快下单" })]);
        const line = dialogueLines(output)[0];
        expect(line).toContain("买它｛强推｝快下单");
        expect(line).not.toContain("{强推}");
    });

    it("produces a valid document with no dialogues when every sentence is a gap", () => {
        const output = buildAssSubtitle([item({ subtitle: "缺口", segments: [] })]);
        expect(dialogueLines(output)).toHaveLength(0);
        expect(output).toContain("[Events]");
        expect(output.trimEnd().endsWith("Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text")).toBe(true);
    });
});

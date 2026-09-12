/**
 * 知识库入库切分：按 Markdown 标题层级优先切分，
 * 单 chunk 300~800 字，chunk 间保留约 10% 重叠，每段记录所属小节标题。
 */

export interface KbChunkDraft {
    ord: number;
    heading: string | null;
    content: string;
}

const CHUNK_MIN = 300;
const CHUNK_MAX = 800;
const OVERLAP = 60;

function cleanMarkdown(content: string) {
    return content
        .replace(/\r\n/g, "\n")
        .replace(/!\[[^\]]*\]\([^)]*\)/g, "") // 图片语法不参与切分与向量化
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

interface Section {
    heading: string | null;
    lines: string[];
}

/** 按标题把文档切成小节；小节前的引言挂在第一个标题下（无标题则为 null） */
function splitSections(markdown: string): Section[] {
    const sections: Section[] = [];
    let current: Section = { heading: null, lines: [] };
    for (const line of markdown.split("\n")) {
        const match = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
        if (match) {
            if (current.lines.length || current.heading !== null) sections.push(current);
            current = { heading: match[2].trim(), lines: [] };
        } else {
            current.lines.push(line);
        }
    }
    if (current.lines.length || current.heading !== null) sections.push(current);
    if (!sections.length) sections.push({ heading: null, lines: [] });
    return sections;
}

/** 把超过上限的正文硬切为若干块，块间带重叠 */
function hardSplit(text: string): string[] {
    if (text.length <= CHUNK_MAX) return [text];
    const parts: string[] = [];
    let start = 0;
    while (start < text.length) {
        let end = Math.min(start + CHUNK_MAX, text.length);
        if (end < text.length) {
            const boundary = text.lastIndexOf("\n", end);
            if (boundary > start + CHUNK_MIN) end = boundary;
        }
        parts.push(text.slice(start, end).trim());
        if (end >= text.length) break;
        start = Math.max(end - OVERLAP, start + 1);
    }
    return parts.filter(Boolean);
}

export function chunkMarkdown(content: string): KbChunkDraft[] {
    const cleaned = cleanMarkdown(content);
    if (!cleaned) return [];
    const chunks: KbChunkDraft[] = [];
    for (const section of splitSections(cleaned)) {
        const paragraphs = section.lines.join("\n").split(/\n{2,}/).map((item) => item.trim()).filter(Boolean);
        let buffer = "";
        const flush = () => {
            for (const part of hardSplit(buffer)) {
                chunks.push({ ord: chunks.length, heading: section.heading, content: part });
            }
            buffer = "";
        };
        for (const paragraph of paragraphs) {
            const candidate = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
            if (candidate.length <= CHUNK_MAX) {
                buffer = candidate;
                continue;
            }
            if (buffer.length >= CHUNK_MIN) flush();
            else if (buffer) {
                // 不足下限的残段并入后续段落，避免碎片
                buffer = candidate;
                if (buffer.length > CHUNK_MAX) flush();
                continue;
            } else {
                buffer = candidate;
            }
            if (buffer.length > CHUNK_MAX) flush();
        }
        if (buffer.trim()) flush();
    }
    return chunks.map((chunk, index) => ({ ...chunk, ord: index }));
}

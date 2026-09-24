import { describe, expect, it } from "vitest";
import { buildJianYingEntries } from "./jianying-export.js";
import { renderOptions, type PlanDocument } from "./semantic-types.js";

const units = [
    { start: 0, end: 6, text: "拉链顺滑。", query: "拉链", tags: [], evidence: [], generic: false, startFrame: 0, endFrame: 90, candidates: [] },
    { start: 6, end: 12, text: "内部分区多。", query: "分区", tags: [], evidence: [], generic: false, startFrame: 90, endFrame: 180, candidates: [] },
];
const shot = (materialId: string, frames: number) => ({ materialId, sourceStart: 0, sourceEnd: frames / 30, speed: 1, frames, manual: false });
const doc = (shotsPerUnit: number[][]): PlanDocument => ({
    fps: 30, duration: 180, audioKey: "audio", embeddingKey: "embed", options: renderOptions.parse({}),
    units: units.map((u) => ({ ...u })),
    variants: [shotsPerUnit.map((framesList) => ({ shots: framesList.map((frames, i) => shot(`m-${frames}-${i}`, frames)), confirmed: true, allowRepeat: false }))],
});

describe("剪映草稿条目构建", () => {
    it("完整覆盖时没有黑场缺口", () => {
        const entries = buildJianYingEntries(doc([[90], [90]]), 0);
        expect(entries).toHaveLength(2);
        expect(entries.every((e) => e.type === "shot")).toBe(true);
        expect(entries.map((e) => e.startFrame)).toEqual([0, 90]);
    });

    it("句中缺口补黑场且时间线无缝", () => {
        const entries = buildJianYingEntries(doc([[30, 30], [90]]), 0);
        expect(entries.map((e) => e.type)).toEqual(["shot", "shot", "gap", "shot"]);
        expect(entries[2]).toMatchObject({ type: "gap", startFrame: 60, frames: 30 });
        // 无缝覆盖：条目首尾相接
        let cursor = 0;
        for (const entry of entries) { expect(entry.startFrame).toBe(cursor); cursor += entry.frames; }
        expect(cursor).toBe(180);
    });

    it("整句无镜头时整句为黑场", () => {
        const entries = buildJianYingEntries(doc([[], [90]]), 0);
        expect(entries).toHaveLength(2);
        expect(entries[0]).toMatchObject({ type: "gap", startFrame: 0, frames: 90 });
    });
});

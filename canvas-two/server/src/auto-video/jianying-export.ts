import type { PlanDocument } from "./semantic-types.js";

export type JianYingEntry = {
    type: "shot" | "gap";
    startFrame: number;
    frames: number;
    materialId?: string;
    sourceStart?: number;
    sourceEnd?: number;
};

// 把某个成片方案的时间线转成剪映草稿条目：镜头在句内按顺序铺排，句内未覆盖的
// 区间（缺口）用黑场条目补齐，保证条目无缝覆盖整条时间线。
export function buildJianYingEntries(doc: PlanDocument, variant: number): JianYingEntry[] {
    const entries: JianYingEntry[] = [];
    doc.variants[variant].forEach((unitShots, index) => {
        const unit = doc.units[index];
        let cursor = unit.startFrame;
        for (const shot of unitShots.shots) {
            if (shot.frames <= 0) continue;
            entries.push({ type: "shot", startFrame: cursor, frames: shot.frames, materialId: shot.materialId, sourceStart: shot.sourceStart, sourceEnd: shot.sourceEnd });
            cursor += shot.frames;
        }
        if (unit.endFrame > cursor) entries.push({ type: "gap", startFrame: cursor, frames: unit.endFrame - cursor });
    });
    return entries;
}

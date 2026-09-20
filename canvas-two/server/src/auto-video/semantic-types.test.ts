import { describe, expect, it } from "vitest";
import { allocateShots, validateUnits, validateVariant, renderOptions, type Candidate, type PlanDocument, type Shot } from "./semantic-types.js";

const annotation = { summary: "拉链开合", parts: ["拉链"], actions: ["开合"], tags: [], shot: "特写", scene: "桌面", colors: [], warnings: [], generic: false, needsReview: false, userNotes: "" };
const candidate = (id: string, duration: number, overrides: Partial<Candidate> = {}): Candidate => ({ id, duration, fileKey: `${id}.mp4`, fileName: "中文素材.mp4", width: 1080, height: 1920, revision: 1, annotation, grade: "strong", relevance: 90, fitScore: 1, reason: "清楚可见拉链开合", missing: [], ...overrides });
function document(candidates: Candidate[], shots: Shot[], frames: number): PlanDocument {
    return { fps: 30, duration: frames/30, audioKey: "audio", embeddingKey: "embed", options: renderOptions.parse({}), units: [{ start: 0, end: 4, text: "拉链顺滑", query: "拉链开合", tags: [], evidence: ["拉链开合"], generic: false, startFrame: 0, endFrame: frames, candidates }], variants: [[{ shots, confirmed: true, allowRepeat: false }]] };
}
describe("本地短片编排约束", () => {
    it("按原文字符区间完整覆盖，包含中文、空格与 emoji", () => {
        const text = "  拉链🎒顺滑。内部分区。";
        expect(() => validateUnits(text,[{start:0,end:9},{start:9,end:text.length}])).not.toThrow();
        for (const ranges of [[{start:1,end:text.length}], [{start:0,end:3},{start:4,end:text.length}], [{start:3,end:text.length},{start:0,end:3}]]) expect(() => validateUnits(text,ranges)).toThrow();
    });
    it("4.6 秒旁白使用 1.5 + 1.8 + 1.3 秒短片", () => {
        const pool = [candidate("a",1.5),candidate("b",1.8),candidate("c",1.6)];
        const shots = allocateShots(pool,138,new Set(),new Map());
        expect(shots.map((s)=>s.frames)).toEqual([45,54,39]);
        expect(shots.every((s)=>s.speed===1)).toBe(true);
        const doc=document(pool,shots,138); expect(()=>validateVariant(doc,doc.variants[0])).not.toThrow();
    });
    it("素材不足、低相关或缺证据不会循环填充", () => {
        const pool=[candidate("a",1),candidate("b",5,{grade:"uncertain"}),candidate("c",5,{missing:["防水实验"]}),candidate("d",.3)];
        const shots=allocateShots(pool,90,new Set(),new Map());
        expect(shots.map((s)=>s.materialId)).toEqual(["a"]);
        const doc=document(pool,shots,90); expect(()=>validateVariant(doc,doc.variants[0])).toThrow("缺口");
    });
    it("不足半秒尾镜重新分配，必要时替换过短的前镜", () => {
        expect(allocateShots([candidate("a",1),candidate("b",1),candidate("c",1)],63,new Set(),new Map()).map((s)=>s.frames)).toEqual([30,18,15]);
        expect(allocateShots([candidate("a",.5),candidate("b",1)],18,new Set(),new Map()).map((s)=>s.frames)).toEqual([18]);
    });
    it("优先相关性，其次画质适配，只有同等候选才做批量差异", () => {
        const pool=[candidate("a",1),candidate("b",1,{relevance:80})];
        expect(allocateShots(pool,30,new Set(),new Map([["a",100]]))[0].materialId).toBe("a");
        expect(allocateShots([candidate("a",1),candidate("b",1)],30,new Set(),new Map([["a",1]]))[0].materialId).toBe("b");
    });
    it("伪造 ID、越界、慢放、重复和未确认被拒绝", () => {
        const pool=[candidate("a",1)], shots=allocateShots(pool,30,new Set(),new Map());
        for (const patch of [{materialId:"invented"},{sourceEnd:2},{speed:.7},{sourceStart:-1},{frames:29},{speed:.9,frames:33}]) {
            const doc=document(pool,[{...shots[0],...patch}],30); expect(()=>validateVariant(doc,doc.variants[0])).toThrow();
        }
        const doc=document(pool,[...shots,...shots],60);
        expect(()=>validateVariant(doc,doc.variants[0])).toThrow("重复");
        doc.variants[0][0].allowRepeat=true;
        expect(()=>validateVariant(doc,doc.variants[0])).not.toThrow();
        doc.variants[0][0].confirmed=false;
        expect(()=>validateVariant(doc,doc.variants[0])).toThrow("确认");
    });
    it("源片不足半秒仅允许手动选用；主动慢放必须按实际区间重新计算", () => {
        const short=candidate("a",.3), shot={materialId:"a",sourceStart:0,sourceEnd:.3,speed:1,frames:9,manual:true};
        const doc=document([short],[shot],9);expect(()=>validateVariant(doc,doc.variants[0])).not.toThrow();
        shot.manual=false;expect(()=>validateVariant(doc,doc.variants[0])).toThrow("超短");
        const slow={...shot,manual:true,sourceEnd:1,speed:.8,frames:37};
        const slowed=document([candidate("a",1)],[slow],37);expect(()=>validateVariant(slowed,slowed.variants[0])).not.toThrow();
    });
    it("受控字体和音乐键不能穿越目录", () => {
        expect(()=>renderOptions.parse({font_name:"../secret.ttf"})).toThrow();
        expect(()=>renderOptions.parse({bgm_file:"C:\\secret.mp3"})).toThrow();
    });
});

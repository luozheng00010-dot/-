import { describe, expect, it } from "vitest";
import { allocateShots, annotationInput, coerceStringArrays, normalizeAnnotation, normalizeColors, validateUnits, validateVariant, renderOptions, shotInput, type Candidate, type PlanDocument, type Shot } from "./semantic-types.js";

const annotation = { summary: "拉链开合", parts: ["拉链"], actions: ["开合"], tags: [], shot: "特写", scene: "桌面", colors: [], warnings: [], generic: false, needsReview: false, userNotes: "" };
const candidate = (id: string, duration: number, overrides: Partial<Candidate> = {}): Candidate => ({ id, duration, fileKey: `${id}.mp4`, fileName: "中文素材.mp4", width: 1080, height: 1920, revision: 1, annotation, grade: "strong", relevance: 90, fitScore: 1, reason: "清楚可见拉链开合", missing: [], ...overrides });
function document(candidates: Candidate[], shots: Shot[], frames: number): PlanDocument {
    return { fps: 30, duration: frames/30, audioKey: "audio", embeddingKey: "embed", options: renderOptions.parse({}), units: [{ start: 0, end: 4, text: "拉链顺滑", query: "拉链开合", tags: [], evidence: ["拉链开合"], generic: false, startFrame: 0, endFrame: frames, candidates }], variants: [[{ shots, confirmed: true, allowRepeat: false }]] };
}
describe("本地短片编排约束", () => {
    it("renderOptions 转场字段默认 none 且拒绝非法值", () => {
        expect(renderOptions.parse({}).video_transition).toBe("none");
        expect(renderOptions.parse({ video_transition: "fade" }).video_transition).toBe("fade");
        expect(renderOptions.parse({ video_transition: "shuffle" }).video_transition).toBe("shuffle");
        expect(() => renderOptions.parse({ video_transition: "glitch" })).toThrow();
    });
    it("镜头级转场可选：合法效果通过、非法拒绝、缺省跟随方案", () => {
        const base = { materialId: "9b2f8a0c-5d3e-4c1a-9f6b-8d7e2a1c3f45", sourceStart: 0, sourceEnd: 2, speed: 1 };
        expect(shotInput.parse({ ...base })).not.toHaveProperty("transition");
        expect(shotInput.parse({ ...base, transition: "fade" }).transition).toBe("fade");
        expect(shotInput.parse({ ...base, transition: "none" }).transition).toBe("none");
        expect(() => shotInput.parse({ ...base, transition: "glitch" })).toThrow();
    });
    it("颜色同义词归一到标准色名并去重", () => {
        expect(normalizeColors(["橘色", "橙色", "桔色"])).toEqual(["橙"]);
        expect(normalizeColors(["浅橘色", "深橙色"])).toEqual(["浅橙", "深橙"]);
        expect(normalizeColors(["玫红", "天蓝", "咖啡色"])).toEqual(["粉", "蓝", "棕"]);
        expect(normalizeColors(["白色", "白"])).toEqual(["白"]);
        expect(normalizeColors(["橘红色", "红色"])).toEqual(["橙", "红"]);
    });
    it("数组字段被模型写成逗号分隔字符串时拆回数组", () => {
        const raw = { summary: "蓝色耳机旋转展示", parts: "耳机, 充电仓", actions: "旋转", tags: "耳机，蓝色，防水", shot: "特写", scene: "桌面", colors: "蓝;白", warnings: "", generic: false, needsReview: false };
        const parsed = annotationInput.parse(normalizeAnnotation(raw));
        expect(parsed.parts).toEqual(["耳机", "充电仓"]);
        expect(parsed.actions).toEqual(["旋转"]);
        expect(parsed.tags).toEqual(["耳机", "蓝色", "防水"]);
        expect(parsed.colors).toEqual(["蓝", "白"]);
        expect(parsed.warnings).toEqual([]);
    });
    it("分句结果的对象数组里 evidence/tags 字符串也能拆回数组", () => {
        const raw = [{ first: 0, last: 1, query: "防水测试", tags: "实验, 水花", evidence: "水流冲刷，桌面无渗漏", generic: false }, { first: 2, last: 2, query: "外观", tags: "", evidence: [], generic: true }];
        const parsed = coerceStringArrays(raw, ["tags", "evidence"]) as typeof raw;
        expect(parsed[0].tags).toEqual(["实验", "水花"]);
        expect(parsed[0].evidence).toEqual(["水流冲刷", "桌面无渗漏"]);
        expect(parsed[1].tags).toEqual([]);
        expect(parsed[1].evidence).toEqual([]);
    });
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

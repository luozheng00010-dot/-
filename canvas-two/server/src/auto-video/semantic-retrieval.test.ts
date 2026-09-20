import { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
vi.mock("../db.js",()=>({prisma:{}}));
vi.mock("./semantic-models.js",()=>({
    resolveModel:async()=>({key:"v1"}), embedTexts:vi.fn(),
    modelJson:vi.fn(async(_model:any,_prompt:string,input:any)=>input.candidates.map((c:any)=>({id:c.id,grade:"strong",relevance:90,reason:"拉链开合",missing:[]}))),
}));
import { modelJson } from "./semantic-models.js";
import { candidatesFor, punctuationRanges } from "./semantic-process.js";
import { annotationInput, planInput, type Unit } from "./semantic-types.js";

describe("文案断句与重排序容错", () => {
    it("英文句点仅在非数字上下文且后随空白或行尾时断句", () => {
        const ranges = punctuationRanges("Zipper opens smoothly. 容量 3.5 升。Done.");
        expect(ranges.map((r) => r.text)).toEqual(["Zipper opens smoothly。", " 容量 3.5 升。", "Done。"]);
        expect(ranges.every((r, i) => r.start === (i ? ranges[i - 1].end : 0))).toBe(true);
        // 小数点、版本号中的句点不断句
        expect(punctuationRanges("v2.0 固件 3.5 升")).toEqual([
            expect.objectContaining({ start: 0, end: "v2.0 固件 3.5 升".length }),
        ]);
    });
    it("重排序结果静默丢弃池外与重复 ID，保留其余顺序", async () => {
        const annotation = { summary: "拉链开合", parts: ["拉链"], actions: ["开合"], tags: [], shot: "特写", scene: "桌面", colors: [], warnings: [], generic: false, needsReview: false, userNotes: "" };
        const row = { id: "30000000-0000-4000-8000-000000000001", file_key: "a.mp4", file_name: "a.mp4", duration: 1.5, width: 1080, height: 1920, revision: 1, annotation };
        const db = { $queryRaw: vi.fn().mockResolvedValue([row]) };
        vi.mocked(modelJson).mockResolvedValueOnce([
            { id: row.id, grade: "strong", relevance: 90, reason: "", missing: [] },
            { id: "00000000-0000-0000-0000-000000000000", grade: "strong", relevance: 80, reason: "", missing: [] },
            { id: row.id, grade: "strong", relevance: 70, reason: "", missing: [] },
        ] as any);
        const input = planInput.parse({ script: "拉链顺滑。", skuId: "10000000-0000-4000-8000-000000000001", categoryIds: ["20000000-0000-4000-8000-000000000001"], voiceName: "voice", voiceRate: 1, options: {} });
        const unit: Unit = { start: 0, end: 5, text: input.script, query: "拉链", tags: [], evidence: [], generic: false, startFrame: 0, endFrame: 45, candidates: [] };
        const result = await candidatesFor(unit, input, { key: "v1" } as any, [1, 0, 0], 60, db as any);
        expect(result.map((c) => c.id)).toEqual([row.id]);
    });
    it("旧标注缺少 userNotes 字段时按空串解析", () => {
        const parsed = annotationInput.parse({ summary: "拉链开合", parts: [], actions: [], tags: [], shot: "", scene: "", colors: [], warnings: [], generic: false, needsReview: false });
        expect(parsed.userNotes).toBe("");
    });
});

// Opt-in, real PostgreSQL/pgvector test. Uses a connection-local temporary table; never changes production tables.
const url=process.env.SEMANTIC_TEST_DATABASE_URL;
describe.skipIf(!url)("千级素材精确检索（独立测试数据库）",()=>{
    it("过滤货号、分类、禁用、删除、陈旧标注及不同模型/维度；标签补召回",async()=>{
        if (!url || !new URL(url).pathname.includes("test")) throw new Error("请使用名称含 test 的专用测试数据库");
        const db=new PrismaClient({datasources:{db:{url}}});
        try { await db.$transaction(async(tx)=>{
            await tx.$executeRawUnsafe(`CREATE TEMP TABLE local_video_materials (id text, file_key text, file_name text, duration float8, width int, height int, revision int, annotation jsonb, notes text, embedding vector, sku_id text, category_id text, deleted_at timestamp, disabled boolean, analysis_status text, indexed_revision int, embedding_key text, embedding_dimension int) ON COMMIT DROP`);
            await tx.$executeRawUnsafe(`INSERT INTO local_video_materials SELECT md5(i::text)::uuid::text, i||'.mp4', '中文拉链-'||i||'.mp4',1.5,1080,1920,1,'{"summary":"拉链开合","parts":["拉链"],"actions":["开合"],"tags":[],"shot":"特写","scene":"桌面","colors":[],"warnings":[],"generic":false,"needsReview":false}'::jsonb,NULL,'[1,0,0]'::vector,'10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001',NULL,false,'ready',1,'v1',3 FROM generate_series(1,1000) i`);
            await tx.$executeRawUnsafe(`UPDATE local_video_materials SET sku_id='other' WHERE file_key::text IN ('1.mp4','2.mp4')`);
            await tx.$executeRawUnsafe(`UPDATE local_video_materials SET category_id='other' WHERE file_key='3.mp4'`);
            await tx.$executeRawUnsafe(`UPDATE local_video_materials SET disabled=true WHERE file_key='4.mp4'`);
            await tx.$executeRawUnsafe(`UPDATE local_video_materials SET deleted_at=NOW() WHERE file_key='5.mp4'`);
            await tx.$executeRawUnsafe(`UPDATE local_video_materials SET revision=2 WHERE file_key='6.mp4'`);
            await tx.$executeRawUnsafe(`UPDATE local_video_materials SET embedding_key='v2',embedding='[1,0]'::vector,embedding_dimension=2 WHERE file_key='7.mp4'`);
            await tx.$executeRawUnsafe(`UPDATE local_video_materials SET analysis_status='failed' WHERE file_key='8.mp4'`);
            const input=planInput.parse({script:"拉链顺滑。",skuId:"10000000-0000-4000-8000-000000000001",categoryIds:["20000000-0000-4000-8000-000000000001"],voiceName:"voice",voiceRate:1,options:{}});
            const unit:Unit={start:0,end:5,text:input.script,query:"拉链",tags:["拉链"],evidence:["开合"],generic:false,startFrame:0,endFrame:45,candidates:[]};
            const result=await candidatesFor(unit,input,{key:"v1"} as any,[1,0,0],60,tx);
            expect(result.length).toBeGreaterThanOrEqual(40);expect(result.length).toBeLessThanOrEqual(60);
            expect(result.every((c)=>!Array.from({length:8},(_,i)=>`${i+1}.mp4`).includes(c.fileKey))).toBe(true);
            expect((await candidatesFor(unit,input,{key:"missing-version"} as any,[1,0,0],60,tx))).toEqual([]);
            const switched=await candidatesFor(unit,input,{key:"v2"} as any,[1,0],60,tx);
            expect(switched.map((c)=>c.fileKey)).toEqual(["7.mp4"]);
        },{timeout:30000}); } finally { await db.$disconnect(); }
    });
});

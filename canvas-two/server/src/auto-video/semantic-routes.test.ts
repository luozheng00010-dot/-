import express, { type ErrorRequestHandler } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(()=>({ plan:vi.fn(),update:vi.fn(),job:vi.fn(),jobs:vi.fn(),materials:vi.fn(),enqueue:vi.fn(),query:vi.fn(),stream:vi.fn() }));
vi.mock("../db.js",()=> { const db={ autoVideoPlan:{findFirst:mocks.plan,updateMany:mocks.update},autoVideoJob:{findUnique:mocks.job,findMany:mocks.jobs},localVideoMaterial:{findMany:mocks.materials},$queryRaw:mocks.query };return { prisma:{...db,$transaction:async(fn:any)=>fn(db)} }; });
vi.mock("./semantic-queue.js",()=>({json:(x:any)=>x,enqueue:mocks.enqueue}));
vi.mock("./engine.js",()=>({forwardStream:mocks.stream}));
import { semanticRouter } from "./semantic-routes.js";
const planId="10000000-0000-4000-8000-000000000001", materialId="20000000-0000-4000-8000-000000000001", categoryId="30000000-0000-4000-8000-000000000001";
const input={script:"拉链顺滑",skuId:planId,categoryIds:[categoryId],voiceName:"voice",voiceRate:1,count:1,options:{}};
const document={audioKey:planId,duration:1,fps:30,embeddingKey:"k",options:{},units:[{text:input.script,startFrame:0,endFrame:30,candidates:[{id:materialId,fileKey:"a.mp4",duration:1,revision:1,grade:"strong",missing:[]}]}],variants:[[{confirmed:true,allowRepeat:false,shots:[{materialId,sourceStart:0,sourceEnd:1,speed:1,frames:30,manual:false}]}]]};
function app() {const app=express();app.use(express.json());app.use((req,_res,next)=>{req.user={id:"member"} as any;next();});app.use(semanticRouter);app.use(((e,_req,res,_next)=>res.status(e.status||400).json({error:e.message})) as ErrorRequestHandler);return app;}
describe("语义方案 API",()=>{
    beforeEach(()=>{vi.resetAllMocks();mocks.plan.mockResolvedValue({id:planId,revision:1,status:"ready",input,document:structuredClone(document)});mocks.job.mockResolvedValue(null);mocks.jobs.mockResolvedValue([]);mocks.materials.mockResolvedValue([{id:materialId,fileKey:"a.mp4",revision:1}]);mocks.enqueue.mockResolvedValue({id:planId,status:"queued"});mocks.update.mockResolvedValue({count:1});});
    it("方案归属在所有读取时限制为当前成员",async()=>{mocks.plan.mockResolvedValue(null);expect((await request(app()).get(`/plans/${planId}`)).status).toBe(404);expect(mocks.plan).toHaveBeenCalledWith({where:{id:planId,createdById:"member"}});});
    it("查询不暴露候选文件键或分析检查点",async()=>{mocks.jobs.mockResolvedValue([{kind:"plan",result:{doc:document}}]);const r=await request(app()).get(`/plans/${planId}`);expect(r.status).toBe(200);expect(JSON.stringify(r.body)).not.toContain("a.mp4");expect(r.body.jobs[0].result).toBeNull();});
    it("旧版本不能渲染",async()=>{expect((await request(app()).post(`/plans/${planId}/render`).send({revision:2,variant:0,requestId:planId})).status).toBe(409);expect(mocks.enqueue).not.toHaveBeenCalled();});
    it("删除、禁用、改标注或换归属后的素材阻止确认",async()=>{for(const materials of [[],[{id:materialId,fileKey:"a.mp4",revision:2}]]){mocks.materials.mockResolvedValue(materials);expect((await request(app()).post(`/plans/${planId}/render`).send({revision:1,variant:0,requestId:planId})).status).toBe(409);}expect(mocks.materials).toHaveBeenCalledWith({where:{id:{in:[materialId]},skuId:planId,categoryId:{in:[categoryId]},deletedAt:null,disabled:false}});});
    it("同版本成片重复提交复用已有任务",async()=>{mocks.job.mockResolvedValue({id:planId,status:"queued"});expect((await request(app()).post(`/plans/${planId}/render`).send({revision:1,variant:0,requestId:planId})).status).toBe(202);expect(mocks.enqueue).not.toHaveBeenCalled();expect(mocks.materials).not.toHaveBeenCalled();});
    it("渲染保存具体文件键、区间与配音，不传递随机选择参数",async()=>{const r=await request(app()).post(`/plans/${planId}/render`).send({revision:1,variant:0,requestId:planId});expect(r.status).toBe(202);const snapshot=mocks.enqueue.mock.calls[0][3];expect(snapshot.shots[0]).toMatchObject({fileKey:"a.mp4",sourceStart:0,sourceEnd:1,speed:1,frames:30});expect(snapshot.audioKey).toBe(planId);expect(snapshot).not.toHaveProperty("video_concat_mode");});
    it("替换或调整源区间不能通过原确认绕过检查",async()=>{const r=await request(app()).patch(`/plans/${planId}`).send({revision:1,edit:{variant:0,unit:0,confirmed:true,allowRepeat:false,shots:[{materialId,sourceStart:0,sourceEnd:2,speed:1}]}});expect(r.status).toBe(400);expect(mocks.update).not.toHaveBeenCalled();});
});

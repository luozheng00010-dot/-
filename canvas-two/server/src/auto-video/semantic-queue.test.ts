import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks=vi.hoisted(()=>({query:vi.fn(),upsert:vi.fn()}));
vi.mock("../db.js",()=>({prisma:{$transaction:async(fn:any)=>fn({$queryRaw:mocks.query}),autoVideoJob:{upsert:mocks.upsert}}}));
import { enqueue,fenced } from "./semantic-queue.js";
describe("数据库队列租约及去重",()=>{
    beforeEach(()=>vi.resetAllMocks());
    it("重启后旧租约不能发布模型或渲染结果",async()=>{mocks.query.mockResolvedValue([]);const publish=vi.fn();await expect(fenced({id:"job",leaseToken:"old"},publish)).rejects.toMatchObject({status:409});expect(publish).not.toHaveBeenCalled();});
    it("有效租约在锁定事务中发布",async()=>{mocks.query.mockResolvedValue([{id:"job"}]);const publish=vi.fn();await fenced({id:"job",leaseToken:"current"},publish);expect(publish).toHaveBeenCalledTimes(1);});
    it("相同请求不会覆盖正在处理的快照",async()=>{await enqueue("render","plan","plan:1:0",{shots:["fixed"]});expect(mocks.upsert).toHaveBeenCalledWith({where:{dedupeKey:"plan:1:0"},create:{kind:"render",targetId:"plan",dedupeKey:"plan:1:0",payload:{shots:["fixed"]}},update:{}});});
});

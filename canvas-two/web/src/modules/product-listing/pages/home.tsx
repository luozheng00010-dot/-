import { PackagePlus } from "lucide-react";

const pipelineSteps = [
    { title: "商品信息采集", description: "录入或抓取商品标题、类目、属性等基础信息" },
    { title: "图片素材处理", description: "主图、详情图自动生成与规格适配" },
    { title: "文案生成", description: "卖点提炼，生成标题、详情与营销文案" },
    { title: "平台接口对接", description: "对接淘宝、拼多多、抖音等平台开放接口" },
    { title: "批量上架与监控", description: "批量提交上架任务，跟踪状态与失败重试" },
];

export default function ProductListingHomePage() {
    return (
        <main className="flex h-full flex-col overflow-y-auto bg-background text-foreground">
            <header className="flex items-center gap-3 border-b border-border px-8 py-5">
                <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                    <PackagePlus className="size-5" />
                </span>
                <div className="min-w-0">
                    <h1 className="text-lg font-semibold tracking-tight">商品自动上架</h1>
                    <p className="truncate text-sm text-muted-foreground">信息采集、图文生成与多平台一键上架</p>
                </div>
                <span className="ml-auto shrink-0 rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground">模块开发中</span>
            </header>

            <section className="mx-auto w-full max-w-3xl flex-1 px-8 py-10">
                <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-16 text-center">
                    <PackagePlus className="size-10 text-muted-foreground/50" />
                    <p className="mt-4 text-sm text-muted-foreground">上架工作台尚未开放，以下为规划中的处理流程</p>
                </div>

                <ol className="mt-10 space-y-1">
                    {pipelineSteps.map((step, index) => (
                        <li key={step.title} className="flex items-baseline gap-4 rounded-lg px-4 py-3 transition hover:bg-muted">
                            <span className="w-6 shrink-0 text-right text-sm font-medium tabular-nums text-muted-foreground">{index + 1}</span>
                            <div className="min-w-0">
                                <div className="text-sm font-medium">{step.title}</div>
                                <div className="mt-0.5 text-sm text-muted-foreground">{step.description}</div>
                            </div>
                        </li>
                    ))}
                </ol>
            </section>
        </main>
    );
}

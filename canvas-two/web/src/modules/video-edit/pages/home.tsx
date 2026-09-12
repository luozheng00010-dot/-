import { Clapperboard } from "lucide-react";

const pipelineSteps = [
    { title: "素材入库打标", description: "镜头切分、抽帧，视觉模型生成结构化标签" },
    { title: "文案拆解", description: "人工文案拆成分镜，标注每句所需画面" },
    { title: "画面匹配", description: "向量检索加模型精排，为每句选出最佳镜头" },
    { title: "时长对齐", description: "按旁白或字幕时长裁切每段画面" },
    { title: "合成导出", description: "ffmpeg 拼接、字幕、BGM 与转场" },
];

export default function VideoEditHomePage() {
    return (
        <main className="flex h-full flex-col overflow-y-auto bg-background text-foreground">
            <header className="flex items-center gap-3 border-b border-border px-8 py-5">
                <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                    <Clapperboard className="size-5" />
                </span>
                <div className="min-w-0">
                    <h1 className="text-lg font-semibold tracking-tight">自动剪辑</h1>
                    <p className="truncate text-sm text-muted-foreground">影棚素材加文案，自动匹配画面出粗剪</p>
                </div>
                <span className="ml-auto shrink-0 rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground">模块开发中</span>
            </header>

            <section className="mx-auto w-full max-w-3xl flex-1 px-8 py-10">
                <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-16 text-center">
                    <Clapperboard className="size-10 text-muted-foreground/50" />
                    <p className="mt-4 text-sm text-muted-foreground">剪辑工作台尚未开放，以下为规划中的处理流程</p>
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

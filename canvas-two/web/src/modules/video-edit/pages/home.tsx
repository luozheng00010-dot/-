import { Link } from "react-router-dom";
import { Clapperboard, FolderOpen, History, PenSquare } from "lucide-react";

const entries = [
    {
        title: "素材库",
        description: "按货号批量上传影棚素材，AI 自动打标入库",
        href: "/video-edit/materials",
        icon: FolderOpen,
        tone: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
    },
    {
        title: "去创作",
        description: "贴一段文案，拆句分镜后自动匹配画面出粗剪",
        href: "/video-edit/create",
        icon: PenSquare,
        tone: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
    },
    {
        title: "导出历史",
        description: "查看合成进度与成片，缺口句自动跳过",
        href: "/video-edit/exports",
        icon: History,
        tone: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
    },
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
                    <p className="truncate text-sm text-muted-foreground">选货号贴文案，自动匹配素材粗剪成片</p>
                </div>
            </header>

            <section className="mx-auto w-full max-w-4xl flex-1 px-8 py-10">
                <div className="rounded-xl border border-border bg-card px-5 py-4 text-sm text-muted-foreground">
                    <p>
                        <span className="mr-2 inline-flex size-5 items-center justify-center rounded-full bg-primary/10 text-center text-xs font-semibold text-primary">1</span>
                        先到素材库，把同货号的影棚视频批量上传（分类选"通用"可补充不露产品的氛围画面），等待打标完成；
                    </p>
                    <p className="mt-1.5">
                        <span className="mr-2 inline-flex size-5 items-center justify-center rounded-full bg-primary/10 text-center text-xs font-semibold text-primary">2</span>
                        再去创作页贴文案，系统拆句分镜、按货号 + 分类自动挑画面，匹配不到的句子会如实标出缺口。
                    </p>
                </div>

                <div className="mt-6 grid gap-4 sm:grid-cols-3">
                    {entries.map((entry) => (
                        <Link
                            key={entry.title}
                            to={entry.href}
                            className="group rounded-xl border border-border bg-card p-5 transition hover:border-primary/40 hover:shadow-sm"
                        >
                            <span className={`grid size-10 place-items-center rounded-lg ${entry.tone}`}>
                                <entry.icon className="size-5" />
                            </span>
                            <h2 className="mt-3 text-sm font-semibold">{entry.title}</h2>
                            <p className="mt-1 text-xs leading-5 text-muted-foreground">{entry.description}</p>
                            <span className="mt-3 inline-block text-xs text-primary opacity-0 transition group-hover:opacity-100">进入 →</span>
                        </Link>
                    ))}
                </div>

                <p className="mt-6 text-xs text-muted-foreground">
                    素材为 1~5 秒的无声单镜头视频；成片导出为 1080×1920 竖版 mp4，字幕自动烧录，缺口句在成片中跳过。
                </p>
            </section>
        </main>
    );
}

import { ArrowRight, FileText, ImagePlus, Images, Video } from "lucide-react";
import { Link } from "react-router-dom";

import { APP_NAME } from "@/constant/app";
import { getHomeModules } from "@/modules/registry";
import { useAuthStore } from "@/stores/use-auth-store";
import { cn } from "@/lib/utils";

const quickEntries = [
    { href: "/image", label: "生图工作台", icon: ImagePlus },
    { href: "/video", label: "视频创作台", icon: Video },
    { href: "/assets", label: "我的资产", icon: Images },
    { href: "/prompts", label: "提示词库", icon: FileText },
];

function greeting() {
    const hour = new Date().getHours();
    if (hour < 6) return "夜深了";
    if (hour < 12) return "上午好";
    if (hour < 18) return "下午好";
    return "晚上好";
}

export default function IndexPage() {
    const user = useAuthStore((state) => state.user);
    const modules = getHomeModules();

    return (
        <main className="h-full overflow-y-auto bg-background text-foreground">
            <div className="mx-auto max-w-5xl px-6 py-10">
                <header>
                    <p className="text-sm font-medium text-muted-foreground">{APP_NAME}</p>
                    <h1 className="mt-1 text-2xl font-semibold tracking-tight">
                        {greeting()}，{user?.username ?? ""}
                    </h1>
                </header>

                <section className="mt-10">
                    <h2 className="text-sm font-semibold text-muted-foreground">模块</h2>
                    <div className="mt-3 grid gap-4 sm:grid-cols-2">
                        {modules.map((mod) => {
                            const Icon = mod.icon;
                            return (
                                <Link
                                    key={mod.href}
                                    to={mod.href}
                                    className="group flex items-start gap-4 rounded-xl border border-border bg-card p-5 transition hover:border-primary/40 hover:shadow-sm"
                                >
                                    <span className={cn("grid size-11 shrink-0 place-items-center rounded-lg", mod.tone)}>
                                        <Icon className="size-5" />
                                    </span>
                                    <div className="min-w-0 flex-1">
                                        <div className="flex items-center justify-between gap-2">
                                            <h3 className="font-medium">{mod.title}</h3>
                                            <ArrowRight className="size-4 shrink-0 text-muted-foreground transition group-hover:translate-x-0.5 group-hover:text-foreground" />
                                        </div>
                                        <p className="mt-1 text-sm leading-6 text-muted-foreground">{mod.description}</p>
                                    </div>
                                </Link>
                            );
                        })}
                    </div>
                </section>

                <section className="mt-10">
                    <h2 className="text-sm font-semibold text-muted-foreground">快捷入口</h2>
                    <div className="mt-3 flex flex-wrap gap-2">
                        {quickEntries.map((entry) => {
                            const Icon = entry.icon;
                            return (
                                <Link
                                    key={entry.href}
                                    to={entry.href}
                                    className="flex items-center gap-2 rounded-lg border border-border px-3.5 py-2 text-sm text-muted-foreground transition hover:border-primary/40 hover:text-foreground"
                                >
                                    <Icon className="size-4" />
                                    {entry.label}
                                </Link>
                            );
                        })}
                    </div>
                </section>
            </div>
        </main>
    );
}

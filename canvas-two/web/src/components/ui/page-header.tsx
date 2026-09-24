import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

interface PageHeaderProps {
    icon: LucideIcon;
    title: string;
    description?: string;
    /** Tailwind classes for the icon tile, e.g. "bg-amber-500/10 text-amber-600 dark:text-amber-400". */
    tone?: string;
    actions?: ReactNode;
    className?: string;
}

export function PageHeader({ icon: Icon, title, description, tone, actions, className }: PageHeaderProps) {
    return (
        <header className={cn("flex flex-wrap items-center gap-3 border-b border-border px-6 py-4", className)}>
            <span className={cn("grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary", tone)}>
                <Icon className="size-5" />
            </span>
            <div className="min-w-0">
                <h1 className="text-base font-semibold tracking-tight">{title}</h1>
                {description && <p className="text-xs text-muted-foreground">{description}</p>}
            </div>
            {actions && <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
    );
}

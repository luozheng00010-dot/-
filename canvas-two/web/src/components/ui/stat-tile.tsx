import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

interface StatTileProps {
    label: string;
    value: number | string;
    hint?: string;
    icon?: LucideIcon;
    /** Tailwind classes for the icon tile / value accent. */
    tone?: string;
    className?: string;
}

export function StatTile({ label, value, hint, icon: Icon, tone, className }: StatTileProps) {
    return (
        <div className={cn("rounded-xl border border-border bg-card p-4", className)}>
            <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">{label}</span>
                {Icon && (
                    <span className={cn("grid size-7 place-items-center rounded-md bg-muted text-muted-foreground", tone)}>
                        <Icon className="size-3.5" />
                    </span>
                )}
            </div>
            <p className="mt-2 text-2xl font-semibold tracking-tight tabular-nums">{value}</p>
            {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
        </div>
    );
}

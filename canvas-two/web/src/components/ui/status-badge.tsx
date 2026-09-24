import { cn } from "@/lib/utils";

export type StatusTone = "processing" | "success" | "warning" | "error" | "muted";

const dotTone: Record<StatusTone, string> = {
    processing: "bg-sky-500",
    success: "bg-emerald-500",
    warning: "bg-amber-500",
    error: "bg-red-500",
    muted: "bg-muted-foreground/50",
};

const textTone: Record<StatusTone, string> = {
    processing: "text-sky-600 dark:text-sky-400",
    success: "text-emerald-600 dark:text-emerald-400",
    warning: "text-amber-600 dark:text-amber-400",
    error: "text-red-600 dark:text-red-400",
    muted: "text-muted-foreground",
};

interface StatusBadgeProps {
    tone: StatusTone;
    label: string;
    pulse?: boolean;
    className?: string;
}

export function StatusBadge({ tone, label, pulse, className }: StatusBadgeProps) {
    return (
        <span className={cn("inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-xs font-medium", textTone[tone], className)}>
            <span className={cn("size-1.5 rounded-full", dotTone[tone], pulse && "animate-pulse")} />
            {label}
        </span>
    );
}

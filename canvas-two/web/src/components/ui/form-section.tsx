import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

interface FormSectionProps {
    step?: number;
    title: string;
    description?: string;
    children: ReactNode;
    className?: string;
}

export function FormSection({ step, title, description, children, className }: FormSectionProps) {
    return (
        <section className={cn("space-y-3", className)}>
            <div className="flex items-center gap-2">
                {step !== undefined && (
                    <span className="grid size-5 shrink-0 place-items-center rounded-full bg-primary/10 text-[11px] font-semibold text-primary">
                        {step}
                    </span>
                )}
                <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
                {description && <p className="min-w-0 truncate text-xs text-muted-foreground">{description}</p>}
            </div>
            <div className="space-y-3">{children}</div>
        </section>
    );
}

interface FieldProps {
    label: string;
    children: ReactNode;
    className?: string;
}

export function Field({ label, children, className }: FieldProps) {
    return (
        <div className={className}>
            <span className="mb-1.5 block text-xs text-muted-foreground">{label}</span>
            {children}
        </div>
    );
}

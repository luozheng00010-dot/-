import { BadgeCheck } from "lucide-react";
import { Streamdown } from "streamdown";
import type { KbPostType } from "../types";

export const POST_TYPE_META: Record<KbPostType, { label: string; className: string }> = {
    insight: { label: "心得", className: "bg-sky-500/10 text-sky-600 dark:text-sky-400" },
    workflow: { label: "流程", className: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" },
    qa: { label: "问答", className: "bg-amber-500/10 text-amber-600 dark:text-amber-400" },
};

export function PostTypeBadge({ type }: { type: KbPostType }) {
    const meta = POST_TYPE_META[type] || POST_TYPE_META.insight;
    return <span className={`shrink-0 rounded px-1.5 py-0.5 text-xs font-medium ${meta.className}`}>{meta.label}</span>;
}

export function OfficialBadge() {
    return (
        <span className="inline-flex shrink-0 items-center gap-0.5 rounded bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary">
            <BadgeCheck className="size-3" />
            官方
        </span>
    );
}

export function IndexStatusTag({ status }: { status: string }) {
    const meta: Record<string, { label: string; className: string }> = {
        pending: { label: "索引中", className: "text-amber-600 dark:text-amber-400" },
        indexing: { label: "索引中", className: "text-amber-600 dark:text-amber-400" },
        indexed: { label: "已索引", className: "text-emerald-600 dark:text-emerald-400" },
        failed: { label: "索引失败", className: "text-red-600 dark:text-red-400" },
    };
    const item = meta[status] || meta.pending;
    return <span className={`text-xs ${item.className}`}>{item.label}</span>;
}

export function KbMarkdown({ content }: { content: string }) {
    return (
        <div className="text-sm leading-6">
            <Streamdown controls={{ code: { copy: true, download: false }, table: { copy: true, download: false, fullscreen: false } }}>{content}</Streamdown>
        </div>
    );
}

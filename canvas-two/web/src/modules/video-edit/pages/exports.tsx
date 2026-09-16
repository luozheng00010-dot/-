import { useCallback, useEffect, useRef, useState } from "react";
import { App, Button, Progress, Table, Tag, Tooltip } from "antd";
import type { TableProps } from "antd";
import { Clapperboard, Download, RefreshCw } from "lucide-react";
import { getVideoExportTask, getVideoTimeline, listVideoExportTasks, mediaContentUrl } from "../api";
import type { VideoExportStatus, VideoExportTask } from "../types";

const statusMeta: Record<VideoExportStatus, { label: string; color: string }> = {
    queued: { label: "排队中", color: "default" },
    running: { label: "合成中", color: "processing" },
    succeeded: { label: "已完成", color: "success" },
    failed: { label: "失败", color: "error" },
};

export default function VideoExportsPage() {
    const { message } = App.useApp();

    const [tasks, setTasks] = useState<VideoExportTask[]>([]);
    const [loading, setLoading] = useState(true);
    const [gapCounts, setGapCounts] = useState<Record<string, number>>({});
    const pollingRef = useRef(false);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const result = await listVideoExportTasks();
            setTasks(result.tasks);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "加载失败");
        } finally {
            setLoading(false);
        }
    }, [message]);

    useEffect(() => { void load(); }, [load]);

    // 有排队/合成中的任务时，每 3 秒轮询单任务进度并更新对应行
    const pollActive = useCallback(async () => {
        if (pollingRef.current) return;
        const active = tasks.filter((task) => task.status === "queued" || task.status === "running");
        if (!active.length) return;
        pollingRef.current = true;
        const updates: VideoExportTask[] = [];
        try {
            for (const task of active) {
                try {
                    const result = await getVideoExportTask(task.id);
                    updates.push(result.task);
                } catch { /* 单次查询失败下轮重试 */ }
            }
        } finally {
            pollingRef.current = false;
        }
        if (updates.length) {
            setTasks((current) => current.map((task) => updates.find((update) => update.id === task.id) || task));
        }
    }, [tasks]);

    useEffect(() => {
        const timer = setInterval(() => { void pollActive(); }, 3000);
        return () => clearInterval(timer);
    }, [pollActive]);

    // 出片后按时间线补齐「跳过 N 句」（gapReport 条数），结果缓存避免重复请求
    useEffect(() => {
        const ids = Array.from(new Set(tasks.filter((task) => task.outputMediaId).map((task) => task.timelineId)));
        const missing = ids.filter((id) => gapCounts[id] === undefined);
        if (!missing.length) return;
        let cancelled = false;
        (async () => {
            const next: Record<string, number> = {};
            for (const id of missing) {
                try {
                    const result = await getVideoTimeline(id);
                    next[id] = result.timeline.gapReport?.items.length || 0;
                } catch {
                    next[id] = 0;
                }
            }
            if (!cancelled && Object.keys(next).length) setGapCounts((current) => ({ ...current, ...next }));
        })();
        return () => { cancelled = true; };
    }, [tasks, gapCounts]);

    const columns: TableProps<VideoExportTask>["columns"] = [
        {
            title: "创建时间",
            dataIndex: "createdAt",
            width: 170,
            render: (value: string) => new Date(value).toLocaleString("zh-CN"),
        },
        {
            title: "状态",
            dataIndex: "status",
            width: 100,
            render: (value: VideoExportStatus) => {
                const meta = statusMeta[value] || { label: value, color: "default" };
                return <Tag color={meta.color}>{meta.label}</Tag>;
            },
        },
        {
            title: "进度",
            dataIndex: "progress",
            width: 220,
            render: (value: number, record) => (
                <Progress
                    percent={record.status === "succeeded" ? 100 : Math.max(0, Math.min(100, value))}
                    size="small"
                    status={record.status === "failed" ? "exception" : record.status === "succeeded" ? "success" : "active"}
                    className="mb-0"
                />
            ),
        },
        {
            title: "错误",
            dataIndex: "error",
            ellipsis: true,
            render: (value: string | null) => (value ? (
                <Tooltip title={value}>
                    <span className="cursor-help text-xs text-red-600 dark:text-red-400">{value}</span>
                </Tooltip>
            ) : (
                <span className="text-muted-foreground">-</span>
            )),
        },
        {
            title: "成片",
            key: "output",
            width: 200,
            render: (_, record) => {
                if (!record.outputMediaId) return <span className="text-muted-foreground">-</span>;
                const gapCount = gapCounts[record.timelineId];
                return (
                    <div className="flex items-center gap-2">
                        <a href={mediaContentUrl(record.outputMediaId)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1">
                            <Download className="size-3.5" />
                            下载
                        </a>
                        {gapCount ? <span className="text-xs text-amber-600 dark:text-amber-400">跳过 {gapCount} 句</span> : null}
                    </div>
                );
            },
        },
    ];

    return (
        <main className="flex h-full flex-col overflow-y-auto bg-background text-foreground">
            <header className="flex flex-wrap items-center gap-3 border-b border-border px-6 py-4">
                <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                    <Clapperboard className="size-5" />
                </span>
                <div className="min-w-0">
                    <h1 className="text-base font-semibold tracking-tight">导出历史</h1>
                    <p className="text-xs text-muted-foreground">1080×1920 竖版粗剪成片，字幕已烧录，缺口句自动跳过</p>
                </div>
                <div className="ml-auto flex shrink-0 items-center gap-2">
                    <Button icon={<RefreshCw className="size-4" />} onClick={() => void load()}>刷新</Button>
                </div>
            </header>

            <section className="mx-auto w-full max-w-5xl flex-1 px-6 py-5">
                <Table<VideoExportTask>
                    rowKey="id"
                    size="middle"
                    loading={loading}
                    columns={columns}
                    dataSource={tasks}
                    pagination={{ pageSize: 20, hideOnSinglePage: true }}
                    locale={{ emptyText: "暂无导出任务，去创作页提交一个吧" }}
                />
            </section>
        </main>
    );
}

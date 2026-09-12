import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { BookOpen, Download, Home, Images, Menu, PanelLeftClose, PanelLeftOpen, Plus, Redo2, Trash2, Undo2, Upload } from "lucide-react";
import { App, Dropdown, Modal, Tooltip, theme as antdTheme } from "antd";

import { UserStatusActions } from "@/components/layout/user-status-actions";
import { canvasThemes } from "@/lib/canvas-theme";
import { useCanvasSidePanelStore } from "@/stores/use-canvas-side-panel-store";
import { useCanvasStore, type CanvasConflictAction, type CanvasLeaseState } from "@/stores/canvas/use-canvas-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { DOCS_URL } from "@/constant/env";

export function CanvasTopBar({
    title,
    titleDraft,
    isTitleEditing,
    onTitleDraftChange,
    onStartTitleEditing,
    onFinishTitleEditing,
    onCancelTitleEditing,
    canUndo,
    canRedo,
    onHome,
    onProjects,
    onCreateProject,
    onDeleteProject,
    onExportProject,
    onImportImage,
    onOpenPlugins,
    onUndo,
    onRedo,
    readOnly,
    leaseState,
    onTakeover,
    canTakeover,
}: {
    title: string;
    titleDraft: string;
    isTitleEditing: boolean;
    onTitleDraftChange: (value: string) => void;
    onStartTitleEditing: () => void;
    onFinishTitleEditing: () => void;
    onCancelTitleEditing: () => void;
    canUndo: boolean;
    canRedo: boolean;
    onHome: () => void;
    onProjects: () => void;
    onCreateProject: () => void;
    onDeleteProject: () => void;
    onExportProject: () => void;
    onImportImage: () => void;
    onOpenPlugins: () => void;
    onUndo: () => void;
    onRedo: () => void;
    readOnly: boolean;
    leaseState?: CanvasLeaseState;
    onTakeover: () => void;
    canTakeover: boolean;
}) {
    const colorTheme = useThemeStore((state) => state.theme);
    const theme = canvasThemes[colorTheme];
    const titleRef = useRef<HTMLDivElement>(null);
    const [shortcutsOpen, setShortcutsOpen] = useState(false);
    const sidePanelOpen = useCanvasSidePanelStore((state) => state.panelOpen);
    const toggleSidePanel = useCanvasSidePanelStore((state) => state.togglePanel);

    useEffect(() => {
        if (!isTitleEditing) return;
        const close = (event: PointerEvent) => {
            if (!titleRef.current?.contains(event.target as Node)) onFinishTitleEditing();
        };
        document.addEventListener("pointerdown", close, true);
        return () => document.removeEventListener("pointerdown", close, true);
    }, [isTitleEditing, onFinishTitleEditing]);

    return (
        <>
            <div className="pointer-events-none absolute left-0 right-0 top-0 z-50 flex h-16 items-center justify-between pl-1 pr-4">
                <div className="pointer-events-auto flex min-w-0 items-center gap-2">
                    <Tooltip title={sidePanelOpen ? "收起面板" : "展开面板"}>
                        <button
                            type="button"
                            onClick={toggleSidePanel}
                            aria-label={sidePanelOpen ? "收起面板" : "展开面板"}
                            className="grid size-7 place-items-center rounded-full transition hover:bg-black/5 dark:hover:bg-white/10"
                            style={{ color: theme.node.text }}
                        >
                            {sidePanelOpen ? <PanelLeftClose className="size-4" /> : <PanelLeftOpen className="size-4" />}
                        </button>
                    </Tooltip>
                    <Dropdown
                        trigger={["click"]}
                        menu={{
                            items: [
                                { key: "home", icon: <Home className="size-4" />, label: "主页", onClick: onHome },
                                { key: "docs", icon: <BookOpen className="size-4" />, label: "文档", onClick: () => window.open(DOCS_URL, "_blank", "noopener,noreferrer") },
                                { key: "projects", icon: <Images className="size-4" />, label: "我的画布", onClick: onProjects },
                                { type: "divider" },
                                { key: "new", icon: <Plus className="size-4" />, label: "新建画布", onClick: onCreateProject },
                                { key: "delete", danger: true, disabled: readOnly, icon: <Trash2 className="size-4" />, label: "删除当前画布", onClick: onDeleteProject },
                                { type: "divider" },
                                { key: "import", disabled: readOnly, icon: <Upload className="size-4" />, label: "导入资产", onClick: onImportImage },
                                { key: "export", icon: <Download className="size-4" />, label: "导出当前画布", onClick: onExportProject },
                                { type: "divider" },
                                { key: "undo", disabled: !canUndo, icon: <Undo2 className="size-4" />, label: <MenuLabel text="撤销" shortcut="⌘ Z" />, onClick: onUndo },
                                { key: "redo", disabled: !canRedo, icon: <Redo2 className="size-4" />, label: <MenuLabel text="重做" shortcut="⌘ ⇧ Z / ⌘ Y" />, onClick: onRedo },
                            ],
                        }}
                    >
                        <button type="button" className="grid size-7 place-items-center rounded-full transition hover:bg-black/5 dark:hover:bg-white/10" style={{ color: theme.node.text }} aria-label="打开画布菜单">
                            <Menu className="size-4" />
                        </button>
                    </Dropdown>

                    <div ref={titleRef} className="flex min-w-0 items-center gap-2">
                        {isTitleEditing ? (
                            <input
                                autoFocus
                                value={titleDraft}
                                onChange={(event) => onTitleDraftChange(event.target.value)}
                                onBlur={onFinishTitleEditing}
                                onKeyDown={(event) => {
                                    if (event.key === "Enter") onFinishTitleEditing();
                                    if (event.key === "Escape") onCancelTitleEditing();
                                }}
                                className="max-w-[280px] bg-transparent p-0 text-left text-lg font-semibold tracking-normal outline-none"
                                style={{ color: theme.node.text }}
                            />
                        ) : (
                            <button
                                type="button"
                                className="max-w-[280px] truncate border-b border-dashed border-transparent text-left text-lg font-semibold tracking-normal transition hover:border-current"
                                onDoubleClick={readOnly ? undefined : onStartTitleEditing}
                                title="双击修改画布名称"
                            >
                                {title}
                            </button>
                        )}
                    </div>
                    <CanvasSaveIndicator />
                    <CanvasLeaseIndicator readOnly={readOnly} leaseState={leaseState} onTakeover={onTakeover} canTakeover={canTakeover} />
                </div>

                <div className="pointer-events-auto flex items-center gap-1.5">
                    <UserStatusActions variant="canvas" showGlobal={false} onOpenShortcuts={() => setShortcutsOpen(true)} onOpenPlugins={onOpenPlugins} />
                </div>
            </div>
            <Modal title="快捷键" open={shortcutsOpen} onCancel={() => setShortcutsOpen(false)} footer={null} centered>
                <div className="space-y-2 border-t pt-4 text-sm" style={{ borderColor: theme.node.stroke }}>
                    <Shortcut keys={["拖动画布"]} value="平移视图" />
                    <Shortcut keys={["滚轮"]} value="缩放画布" />
                    <Shortcut keys={["缩放滑杆"]} value="精确调整缩放" />
                    <Shortcut keys={["Ctrl / Cmd", "拖动"]} value="框选多个节点" />
                    <Shortcut keys={["Shift / Ctrl / Cmd", "点击"]} value="追加选择节点" />
                    <Shortcut keys={["Ctrl / Cmd", "A"]} value="全选节点" />
                    <Shortcut keys={["Ctrl / Cmd", "C / V"]} value="复制 / 粘贴节点，或粘贴剪切板文本/图片" />
                    <Shortcut keys={["Ctrl / Cmd", "Z"]} value="撤销" />
                    <Shortcut keys={["Ctrl / Cmd", "Shift", "Z"]} value="重做" />
                    <Shortcut keys={["Ctrl / Cmd", "Y"]} value="重做" />
                    <Shortcut keys={["Delete / Backspace"]} value="删除选中" />
                    <Shortcut keys={["Esc"]} value="取消选择并关闭浮层" />
                    <Shortcut keys={["拖入图片/视频/音频"]} value="上传到画布" />
                </div>
            </Modal>
        </>
    );
}

function CanvasLeaseIndicator({ readOnly, leaseState, onTakeover, canTakeover }: { readOnly: boolean; leaseState?: CanvasLeaseState; onTakeover: () => void; canTakeover: boolean }) {
    const colorTheme = useThemeStore((state) => state.theme);
    const theme = canvasThemes[colorTheme];
    if (!readOnly && leaseState?.status !== "held") return null;
    if (!readOnly && leaseState?.status === "held") return <span className="h-8 content-center text-xs" style={{ color: theme.node.muted }}>当前可编辑</span>;
    const holder = leaseState?.lease?.holderUsername;
    if (!canTakeover) return <span className="h-8 content-center text-xs" style={{ color: theme.node.muted }}>当前只读{holder ? ` · ${holder} 正在编辑` : ""}</span>;
    return (
        <button type="button" className="h-8 text-xs transition hover:opacity-75" style={{ color: theme.node.muted }} onClick={onTakeover} title={leaseState?.error || "当前画布只读"}>
            当前只读{holder ? ` · ${holder} 正在编辑` : ""} · 接管编辑
        </button>
    );
}

function CanvasSaveIndicator() {
    const { message, modal } = App.useApp();
    const projectId = useParams<{ id: string }>().id || "";
    const saveState = useCanvasStore((state) => state.saveStates[projectId]);
    const retryProjectSave = useCanvasStore((state) => state.retryProjectSave);
    const resolveProjectConflict = useCanvasStore((state) => state.resolveProjectConflict);
    const colorTheme = useThemeStore((state) => state.theme);
    const theme = canvasThemes[colorTheme];
    const { token } = antdTheme.useToken();

    if (!saveState || saveState.status === "idle") return null;

    const resolveConflict = (action: CanvasConflictAction) => {
        const overwrite = action === "overwrite";
        modal.confirm({
            title: overwrite ? "覆盖服务器版本？" : "重新加载服务器版本？",
            content: overwrite ? "当前画布将覆盖其他标签页已经保存的内容。" : "当前未保存的修改将被丢弃。",
            okText: overwrite ? "覆盖保存" : "重新加载",
            cancelText: "取消",
            okButtonProps: { danger: !overwrite },
            onOk: async () => {
                const ok = await resolveProjectConflict(projectId, action);
                if (!ok) return message.error("操作失败，请重试");
                message.success(overwrite ? "画布已覆盖保存" : "已加载服务器版本");
                if (!overwrite) window.location.reload();
            },
        });
    };

    if (saveState.status === "conflict") {
        return (
            <Dropdown
                trigger={["click"]}
                menu={{
                    items: [
                        { key: "overwrite", label: "覆盖保存当前画布", onClick: () => resolveConflict("overwrite") },
                        { key: "reload", danger: true, label: "重新加载服务器版本", onClick: () => resolveConflict("reload") },
                    ],
                }}
            >
                <button type="button" className="h-8 text-xs transition hover:opacity-70" style={{ color: token.colorWarning }} title={saveState.error}>保存冲突</button>
            </Dropdown>
        );
    }

    if (saveState.status === "error") {
        return (
            <button
                type="button"
                className="h-8 text-xs transition hover:opacity-70"
                style={{ color: token.colorError }}
                title={saveState.error}
                onClick={() => void retryProjectSave(projectId).then((ok) => ok ? message.success("画布已保存") : message.error("保存失败，请重试"))}
            >
                保存失败 · 重试
            </button>
        );
    }

    const label = saveState.status === "saving" ? "保存中…" : saveState.status === "dirty" ? "等待保存…" : "已保存";
    return <span className="h-8 content-center text-xs" style={{ color: theme.node.muted }}>{label}</span>;
}

function MenuLabel({ text, shortcut }: { text: string; shortcut: string }) {
    return (
        <span className="flex min-w-36 items-center justify-between gap-8">
            <span>{text}</span>
            <span className="text-xs opacity-45">{shortcut}</span>
        </span>
    );
}

function Shortcut({ keys, value }: { keys: string[]; value: string }) {
    return (
        <div className="grid grid-cols-[minmax(0,1fr)_120px] items-center gap-6 rounded-lg px-1 py-1.5">
            <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                {keys.map((key, index) => (
                    <span key={`${key}-${index}`} className="flex items-center gap-1.5">
                        {index ? <span className="text-xs opacity-35">+</span> : null}
                        <kbd
                            className="min-w-9 rounded-md border px-2.5 py-1.5 text-center text-xs font-medium leading-none shadow-[inset_0_-1px_0_rgba(0,0,0,.08),0_1px_2px_rgba(0,0,0,.06)]"
                            style={{ borderColor: "rgba(120,113,108,.28)", background: "linear-gradient(#fff, rgba(245,245,244,.92))", color: "rgb(68,64,60)" }}
                        >
                            {key}
                        </kbd>
                    </span>
                ))}
            </span>
            <span className="text-right text-sm opacity-55">{value}</span>
        </div>
    );
}

import { useEffect } from "react";
import type { ReactNode } from "react";
import {
    Box,
    Copy,
    FileImage,
    FileSearch,
    Files,
    FileText,
    ImageIcon,
    List,
    Pencil,
    Sparkles,
    Target,
    Trash2,
    Users,
    Video,
} from "lucide-react";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasNodeType, type CanvasNodeTypeId, type ContextMenuState } from "@/types/canvas";
import { ConnectionCreateOption } from "./canvas-create-menus";

const ECOMMERCE_OPTIONS = [
    { title: "竞品视觉复刻", description: "保留自己的商品，迁移竞品视觉策略", icon: <Copy className="size-5" /> },
    { title: "复刻详情页", description: "按参考详情页逐张生成对应结果", icon: <Files className="size-5" /> },
    { title: "1:1主图复刻", description: "按参考主图生成正方形结果", icon: <ImageIcon className="size-5" /> },
    { title: "卖点主图生成", description: "把商品图变成单一卖点清晰的主图", icon: <Target className="size-5" /> },
    { title: "买家秀裂变", description: "生成真实生活感的多场景使用图", icon: <Users className="size-5" /> },
    { title: "白底主图", description: "生成平台可用的纯白商品展示图", icon: <FileImage className="size-5" /> },
    { title: "主图策略拆解", description: "拆构图、卖点层级和点击风险", icon: <FileSearch className="size-5" /> },
    { title: "详情页结构拆解", description: "判断页面叙事、证据和信息缺口", icon: <FileText className="size-5" /> },
    { title: "SKU 卖点拆解", description: "识别规格层级、选择逻辑和混淆风险", icon: <Box className="size-5" /> },
] as const;

const GENERAL_OPTIONS = [
    { title: "文本生成", description: "脚本、广告词、品牌文案", icon: <List className="size-5" /> },
    { title: "图片生成", description: "宣传图、海报、封面", icon: <ImageIcon className="size-5" /> },
    { title: "视频生成", description: "宣传视频、动画、电影", icon: <Video className="size-5" /> },
    { title: "图片编辑器", description: "编辑和处理图片", icon: <Pencil className="size-5" /> },
    { title: "3D 世界", description: "场景与资产生成、虚拟展览", icon: <Sparkles className="size-5" />, badge: "Beta" },
] as const;

export function CanvasNodeContextMenu({
    menu,
    nodeType,
    onClose,
    onDuplicate,
    onDelete,
    onStartCompetitorReplication,
    onStartDetailPageReplication,
    onStartMainImageReplication,
    onPlaceholder,
}: {
    menu: ContextMenuState;
    nodeType?: CanvasNodeTypeId;
    onClose: () => void;
    onDuplicate: () => void;
    onDelete: () => void;
    onStartCompetitorReplication: (nodeId: string) => void;
    onStartDetailPageReplication: (nodeId: string) => void;
    onStartMainImageReplication: (nodeId: string) => void;
    onPlaceholder: (label: string) => void;
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const isImageNode = menu.type === "node" && nodeType === CanvasNodeType.Image;
    const viewportWidth = typeof window === "undefined" ? 0 : window.innerWidth;
    const viewportHeight = typeof window === "undefined" ? 0 : window.innerHeight;
    const menuWidth = isImageNode ? 354 : 188;
    const estimatedMenuHeight = isImageNode ? Math.min(viewportHeight * 0.8, 720) + 24 : 112;
    const menuLeft = viewportWidth ? Math.max(12, Math.min(menu.x, viewportWidth - menuWidth)) : menu.x;
    const menuTop = viewportHeight ? Math.max(12, Math.min(menu.y, viewportHeight - estimatedMenuHeight)) : menu.y;

    useEffect(() => {
        const close = (event: PointerEvent) => {
            const target = event.target;
            if (target instanceof Element && target.closest(".ant-popover")) return;
            onClose();
        };
        window.addEventListener("pointerdown", close);
        return () => window.removeEventListener("pointerdown", close);
    }, [onClose]);

    return (
        <div
            className={`fixed z-[80] overflow-hidden border shadow-2xl ${isImageNode ? "max-h-[min(80vh,720px)] w-[330px] overflow-y-auto rounded-[18px] p-3 backdrop-blur thin-scrollbar" : "min-w-44 rounded-xl py-1"}`}
            style={{ left: menuLeft, top: menuTop, background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
            onPointerDown={(event) => event.stopPropagation()}
        >
            {isImageNode ? (
                <>
                    <div className="mb-2 px-1">
                        <div className="text-sm font-medium" style={{ color: theme.node.muted }}>
                            引用该节点生成
                        </div>
                        <div className="mt-2 flex items-center gap-2 px-1 text-xs">
                            <span className="font-semibold" style={{ color: theme.node.text }}>
                                电商视觉
                            </span>
                            <span style={{ color: theme.node.muted }}>商品图与参考图一对一生成</span>
                        </div>
                    </div>
                    <div className="grid gap-1">
                        {ECOMMERCE_OPTIONS.map((option) => (
                            <ConnectionCreateOption
                                key={option.title}
                                theme={theme}
                                icon={option.icon}
                                title={option.title}
                                description={option.description}
                                onClick={() => menu.type === "node" && option.title === "竞品视觉复刻" ? onStartCompetitorReplication(menu.nodeId) : menu.type === "node" && option.title === "复刻详情页" ? onStartDetailPageReplication(menu.nodeId) : menu.type === "node" && option.title === "1:1主图复刻" ? onStartMainImageReplication(menu.nodeId) : onPlaceholder(option.title)}
                            />
                        ))}
                    </div>
                    <div className="my-2 border-t" style={{ borderColor: theme.toolbar.border }} />
                    <div className="mb-1 px-1 text-xs font-semibold" style={{ color: theme.node.muted }}>
                        通用生成
                    </div>
                    <div className="grid gap-1">
                        {GENERAL_OPTIONS.map((option) => (
                            <ConnectionCreateOption key={option.title} theme={theme} icon={option.icon} title={option.title} description={option.description} badge={option.badge} onClick={() => onPlaceholder(option.title)} />
                        ))}
                    </div>
                    <div className="my-2 border-t" style={{ borderColor: theme.toolbar.border }} />
                    <MenuButton icon={<Copy className="size-4" />} label="复制" onClick={onDuplicate} />
                    <MenuButton icon={<Trash2 className="size-4" />} label="删除" onClick={onDelete} danger />
                </>
            ) : (
                <>
                    {menu.type === "node" ? <MenuButton icon={<Copy className="size-4" />} label="复制" onClick={onDuplicate} /> : null}
                    <MenuButton icon={<Trash2 className="size-4" />} label="删除" onClick={onDelete} danger />
                </>
            )}
        </div>
    );
}

function MenuButton({ icon, label, onClick, danger = false }: { icon: ReactNode; label: string; onClick?: () => void; danger?: boolean }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];

    return (
        <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:opacity-80" style={{ color: danger ? "#f87171" : theme.node.text }} onClick={onClick}>
            {icon}
            <span>{label}</span>
        </button>
    );
}

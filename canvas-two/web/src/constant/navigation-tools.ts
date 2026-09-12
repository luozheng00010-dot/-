import { FileText, ImagePlus, Images, LayoutTemplate, Maximize2, PackageOpen, Settings2, Sparkles, Video } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import "@/modules";
import { getModuleNavItems } from "@/modules/registry";

export const navigationTools = [
    {
        slug: "canvas",
        label: "我的画布",
        icon: Maximize2,
        group: "项目",
    },
    {
        slug: "image",
        label: "生图工作台",
        icon: ImagePlus,
        group: "专业工具",
    },
    {
        slug: "video",
        label: "视频创作台",
        icon: Video,
        group: "专业工具",
    },
    {
        slug: "products",
        label: "商品图",
        icon: PackageOpen,
        group: "专业工具",
    },
    {
        slug: "detail-pages",
        label: "详情页复刻",
        icon: LayoutTemplate,
        group: "专业工具",
    },
    {
        slug: "detail-page-templates",
        label: "详情页模板",
        icon: LayoutTemplate,
        group: "专业工具",
    },
    {
        slug: "main-image-replications",
        label: "1:1 主图复刻",
        icon: Sparkles,
        group: "专业工具",
    },
    {
        slug: "main-image-replication-templates",
        label: "主图模板",
        icon: LayoutTemplate,
        group: "专业工具",
    },
    {
        slug: "prompts",
        label: "提示词库",
        icon: FileText,
        group: "资产",
    },
    {
        slug: "assets",
        label: "我的资产",
        icon: Images,
        group: "资产",
    },
    {
        slug: "config",
        label: "配置",
        icon: Settings2,
        group: "设置",
    },
] as const;

// 放宽为 string：注册模块的 slug 不在 navigationTools 常量里，但同样参与导航激活判断
export type NavigationToolSlug = (typeof navigationTools)[number]["slug"] | (string & {});

export type NavigationItem = {
    key: string;
    label: string;
    icon: LucideIcon;
    href?: string;
    action?: "agent";
    /** 下拉子项；有 children 的项在侧边栏渲染为可展开下拉 */
    children?: NavigationChildItem[];
};

export type NavigationChildItem = {
    key: string;
    label: string;
    href: string;
};

export type NavigationGroup = {
    label: string;
    items: NavigationItem[];
};

function itemsForGroup(group: string): NavigationItem[] {
    return navigationTools
        .filter((tool) => tool.group === group)
        .map((tool) => ({ key: tool.slug, label: tool.label, icon: tool.icon, href: `/${tool.slug}` }));
}

function moduleItems(): NavigationItem[] {
    return getModuleNavItems().map((item) => ({
        key: item.key,
        label: item.label,
        icon: item.icon,
        href: item.path,
        children: (item.children ?? [{ key: `${item.key}-home`, label: "工作台", path: item.path }]).map((child) => ({
            key: child.key,
            label: child.label,
            href: child.path,
        })),
    }));
}

/** 画布模块的下拉子项：画布及其专业工具页（路由均为现有静态路由） */
const canvasChildren: NavigationChildItem[] = [
    { key: "canvas", label: "我的画布", href: "/canvas" },
    { key: "image", label: "生图工作台", href: "/image" },
    { key: "video", label: "视频创作台", href: "/video" },
    { key: "products", label: "商品图", href: "/products" },
    { key: "detail-pages", label: "详情页复刻", href: "/detail-pages" },
    { key: "detail-page-templates", label: "详情页模板", href: "/detail-page-templates" },
    { key: "main-image-replications", label: "1:1 主图复刻", href: "/main-image-replications" },
    { key: "main-image-replication-templates", label: "主图模板", href: "/main-image-replication-templates" },
];

export const navigationGroups: NavigationGroup[] = [
    {
        label: "创作",
        items: [{ key: "agent", label: "创作 Agent", icon: Sparkles, action: "agent" }],
    },
    {
        label: "模块",
        items: [{ key: "canvas", label: "画布", icon: Maximize2, href: "/canvas", children: canvasChildren }, ...moduleItems()],
    },
    { label: "资产", items: itemsForGroup("资产") },
    { label: "设置", items: itemsForGroup("设置") },
];

/** 全部导航路径首段（内置工具 + 注册模块），用于侧边栏/抽屉的激活态判断 */
export const navigationSlugs: string[] = [
    ...navigationTools.map((tool) => tool.slug),
    ...getModuleNavItems().map((item) => item.path.replace(/^\/+/, "").split("/")[0]),
];

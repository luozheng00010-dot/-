import { lazy } from "react";
import { Clapperboard } from "lucide-react";

import { registerModule } from "../registry";

const HomePage = lazy(() => import("./pages/home"));
const MaterialsPage = lazy(() => import("./pages/materials"));
const CreatePage = lazy(() => import("./pages/create"));
const TimelinePage = lazy(() => import("./pages/timeline"));
const ExportsPage = lazy(() => import("./pages/exports"));
const SettingsPage = lazy(() => import("./pages/settings"));

registerModule({
    id: "video-edit",
    nav: [
        {
            key: "video-edit",
            label: "自动剪辑",
            icon: Clapperboard,
            path: "/video-edit",
            group: "专业工具",
            children: [
                { key: "video-edit-materials", label: "素材库", path: "/video-edit/materials" },
                { key: "video-edit-create", label: "去创作", path: "/video-edit/create" },
                { key: "video-edit-exports", label: "导出历史", path: "/video-edit/exports" },
                { key: "video-edit-settings", label: "管理设置", path: "/video-edit/settings" },
            ],
        },
    ],
    routes: [
        { path: "/video-edit", Component: HomePage },
        { path: "/video-edit/materials", Component: MaterialsPage },
        { path: "/video-edit/create", Component: CreatePage },
        // 时间线编辑器：不加导航项，从创作页步骤 3 进入（URL 可分享）
        { path: "/video-edit/timeline/:id", Component: TimelinePage },
        { path: "/video-edit/exports", Component: ExportsPage },
        { path: "/video-edit/settings", Component: SettingsPage },
    ],
    home: {
        title: "自动剪辑",
        description: "选货号贴文案，自动匹配素材粗剪成片",
        icon: Clapperboard,
        href: "/video-edit",
        tone: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    },
});

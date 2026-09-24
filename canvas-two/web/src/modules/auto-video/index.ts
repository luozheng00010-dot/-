import { lazy } from "react";
import { Clapperboard } from "lucide-react";

import { registerModule } from "../registry";

registerModule({
    id: "auto-video",
    nav: [
        {
            key: "auto-video",
            label: "自动剪辑",
            icon: Clapperboard,
            path: "/auto-video",
            group: "专业工具",
            children: [
                { key: "auto-video-workbench", label: "剪辑工作台", path: "/auto-video" },
                { key: "auto-video-materials", label: "本地素材库", path: "/auto-video/materials" },
                { key: "auto-video-search", label: "画面查询", path: "/auto-video/search" },
                { key: "auto-video-plans", label: "本地剪辑方案", path: "/auto-video/plans" },
                { key: "auto-video-admin", label: "管理设置", path: "/auto-video/admin" },
            ],
        },
    ],
    routes: [
        { path: "/auto-video", Component: lazy(() => import("./pages/auto-video")) },
        { path: "/auto-video/materials", Component: lazy(() => import("./pages/materials")) },
        { path: "/auto-video/search", Component: lazy(() => import("./pages/search")) },
        { path: "/auto-video/plans", Component: lazy(() => import("./pages/plans")) },
        { path: "/auto-video/plans/:id", Component: lazy(() => import("./pages/plans")) },
        { path: "/auto-video/admin", Component: lazy(() => import("./pages/admin")) },
    ],
    home: {
        title: "自动剪辑",
        description: "一键成片：文案、素材、配音、字幕自动合成",
        icon: Clapperboard,
        href: "/auto-video",
        tone: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
    },
});

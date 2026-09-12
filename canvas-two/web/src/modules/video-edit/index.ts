import { lazy } from "react";
import { Clapperboard } from "lucide-react";

import { registerModule } from "../registry";

registerModule({
    id: "video-edit",
    nav: [
        {
            key: "video-edit",
            label: "自动剪辑",
            icon: Clapperboard,
            path: "/video-edit",
            group: "专业工具",
        },
    ],
    routes: [{ path: "/video-edit", Component: lazy(() => import("./pages/home")) }],
    home: {
        title: "自动剪辑",
        description: "影棚素材加文案，自动匹配画面出粗剪",
        icon: Clapperboard,
        href: "/video-edit",
        tone: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    },
});

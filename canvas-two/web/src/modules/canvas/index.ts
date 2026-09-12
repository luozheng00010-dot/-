import { Maximize2 } from "lucide-react";

import { registerModule } from "../registry";

// 画布模块的路由与侧边栏导航沿用现有实现（router.tsx / navigation-tools.ts），
// 这里只注册工作台首页的模块卡片，让画布成为壳下的普通模块之一。
registerModule({
    id: "canvas",
    home: {
        title: "无限画布",
        description: "生成、连接和重组图片、文字与图形，让创作从单次生成变成连续推演",
        icon: Maximize2,
        href: "/canvas",
        tone: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
    },
});

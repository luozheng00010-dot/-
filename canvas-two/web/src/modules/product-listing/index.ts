import { lazy } from "react";
import { PackagePlus } from "lucide-react";

import { registerModule } from "../registry";

registerModule({
    id: "product-listing",
    nav: [
        {
            key: "product-listing",
            label: "商品自动上架",
            icon: PackagePlus,
            path: "/product-listing",
            group: "专业工具",
        },
    ],
    routes: [{ path: "/product-listing", Component: lazy(() => import("./pages/home")) }],
    home: {
        title: "商品自动上架",
        description: "商品信息采集、图文生成与多平台一键上架",
        icon: PackagePlus,
        href: "/product-listing",
        tone: "bg-orange-500/10 text-orange-600 dark:text-orange-400",
    },
});

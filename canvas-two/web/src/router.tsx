import { Suspense } from "react";
import { createBrowserRouter } from "react-router-dom";
import { AnalyticsTracker } from "@/components/layout/analytics-tracker";
import ProtectedLayout from "@/layouts/protected-layout";
import "@/modules";
import { getModuleRoutes } from "@/modules/registry";
import AdminPage from "@/pages/admin";
import AssetsPage from "@/pages/assets";
import CanvasPage from "@/pages/canvas";
import CanvasProjectPage from "@/pages/canvas/project";
import ConfigPage from "@/pages/config";
import DetailPagesPage from "@/pages/detail-pages";
import DetailPageTemplatesPage from "@/pages/detail-page-templates";
import HomePage from "@/pages/home";
import ImagePage from "@/pages/image";
import LoginPage from "@/pages/login";
import NotFound from "@/pages/not-found";
import PromptsPage from "@/pages/prompts";
import ProductsPage from "@/pages/products";
import MainImageReplicationsPage from "@/pages/main-image-replications";
import MainImageReplicationTemplatesPage from "@/pages/main-image-replication-templates";
import VideoPage from "@/pages/video";

// 模块注册表贡献的懒加载路由，统一包 Suspense
const moduleRouteObjects = getModuleRoutes().map((route) => ({
    path: route.path.replace(/^\/+/, ""),
    element: (
        <Suspense fallback={<div className="grid h-full place-items-center text-sm text-muted-foreground">加载中…</div>}>
            <route.Component />
        </Suspense>
    ),
}));

export const router = createBrowserRouter([
    { path: "/login", element: <LoginPage /> },
    {
        element: <ProtectedLayout />,
        children: [
            { path: "/", element: <><AnalyticsTracker /><HomePage /></> },
            { path: "/image", element: <ImagePage /> },
            { path: "/video", element: <VideoPage /> },
            { path: "/assets", element: <AssetsPage /> },
            { path: "/prompts", element: <PromptsPage /> },
            { path: "/products", element: <ProductsPage /> },
            { path: "/main-image-replications", element: <MainImageReplicationsPage /> },
            { path: "/main-image-replication-templates", element: <MainImageReplicationTemplatesPage /> },
            { path: "/detail-pages", element: <DetailPagesPage /> },
            { path: "/detail-page-templates", element: <DetailPageTemplatesPage /> },
            { path: "/canvas", element: <CanvasPage /> },
            { path: "/canvas/:id", element: <CanvasProjectPage /> },
            { path: "/config", element: <ConfigPage /> },
            { path: "/admin", element: <AdminPage /> },
            ...moduleRouteObjects,
        ],
    },
    { path: "*", element: <NotFound /> },
], { basename: import.meta.env.BASE_URL.replace(/\/+$/, "") || "/" });

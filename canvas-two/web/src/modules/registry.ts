import type { ComponentType, LazyExoticComponent } from "react";
import type { LucideIcon } from "lucide-react";

/**
 * 壳应用的模块注册表。
 *
 * 每个业务模块（如 video-edit）在自己的目录里调用 registerModule，
 * 声明自己的路由和侧边栏导航项；壳（router.tsx / navigation-tools.ts）统一消费。
 *
 * 约束：
 * - 模块之间不允许互相 import；共享逻辑只能放 src/lib、src/services 等公共层。
 * - 路由组件必须用 React.lazy 包装，保证模块代码按需加载、互不影响。
 */

export interface ModuleRouteDefinition {
    /** 绝对路径，如 "/video-edit"；挂载到路由时会转为相对路径 */
    path: string;
    Component: LazyExoticComponent<ComponentType>;
}

export interface ModuleNavDefinition {
    key: string;
    label: string;
    icon: LucideIcon;
    path: string;
    /** 对应侧边栏分组名，如 "专业工具" */
    group: string;
    /** 下拉子项；不填时侧边栏自动挂一个指向 path 的"工作台"子项 */
    children?: ModuleNavChild[];
}

export interface ModuleNavChild {
    key: string;
    label: string;
    path: string;
}

export interface AppModuleDefinition {
    id: string;
    routes?: ModuleRouteDefinition[];
    nav?: ModuleNavDefinition[];
    /** 工作台首页展示的模块卡片 */
    home?: ModuleHomeCard;
}

export interface ModuleHomeCard {
    title: string;
    description: string;
    icon: LucideIcon;
    href: string;
    /** 卡片主色，Tailwind 类，如 "bg-sky-500/10 text-sky-600 dark:text-sky-400" */
    tone: string;
}

const registeredModules: AppModuleDefinition[] = [];

export function registerModule(definition: AppModuleDefinition) {
    // 防止 HMR / 重复 import 造成重复注册
    if (registeredModules.some((mod) => mod.id === definition.id)) return;
    registeredModules.push(definition);
}

export function getModuleRoutes(): ModuleRouteDefinition[] {
    return registeredModules.flatMap((mod) => mod.routes ?? []);
}

export function getModuleNavItems(): ModuleNavDefinition[] {
    return registeredModules.flatMap((mod) => mod.nav ?? []);
}

export function getHomeModules(): ModuleHomeCard[] {
    return registeredModules.map((mod) => mod.home).filter((home) => home !== undefined);
}

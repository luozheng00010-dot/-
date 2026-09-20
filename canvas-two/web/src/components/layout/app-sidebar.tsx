import { useEffect, useState } from "react";
import { BookOpen, Bot, ChevronRight, LogOut, Menu, Moon, PanelLeftClose, PanelLeftOpen, Settings2, Shield, Sun, UserCircle } from "lucide-react";
import { Dropdown, Tooltip } from "antd";
import { Link, useLocation, useNavigate } from "react-router-dom";

import { navigationGroups, navigationSlugs, type NavigationItem } from "@/constant/navigation-tools";
import { APP_NAME } from "@/constant/app";
import { DOCS_URL } from "@/constant/env";
import { AnimatedThemeToggler } from "@/components/ui/animated-theme-toggler";
import { MobileNavDrawer } from "@/components/layout/mobile-nav-drawer";
import { UserStatusActions } from "@/components/layout/user-status-actions";
import { cn } from "@/lib/utils";
import { useAgentStore } from "@/stores/use-agent-store";
import { useAuthStore } from "@/stores/use-auth-store";
import { useConfigStore } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";

const SIDEBAR_COLLAPSED_KEY = "app-sidebar-collapsed";

function readCollapsedState() {
    if (typeof window === "undefined") return true;
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) !== "false";
}

function isItemActive(item: NavigationItem, pathname: string) {
    if (item.children?.length) {
        return item.children.some((child) => pathname === child.href || pathname.startsWith(`${child.href}/`));
    }
    if (!item.href) return false;
    if (item.href === "/canvas") return pathname === "/canvas" || pathname.startsWith("/canvas/");
    return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

export function AppSidebar() {
    const { pathname } = useLocation();
    const navigate = useNavigate();
    const user = useAuthStore((state) => state.user);
    const logout = useAuthStore((state) => state.logout);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const theme = useThemeStore((state) => state.theme);
    const setTheme = useThemeStore((state) => state.setTheme);
    const toggleAgent = useAgentStore((state) => state.togglePanel);
    const [collapsed, setCollapsed] = useState(readCollapsedState);
    const [openKeys, setOpenKeys] = useState<string[]>(() =>
        navigationGroups.flatMap((group) =>
            group.items
                .filter((item) => item.children?.some((child) => pathname === child.href || pathname.startsWith(`${child.href}/`)))
                .map((item) => item.key),
        ),
    );
    const [mobileNavOpen, setMobileNavOpen] = useState(false);
    const slug = pathname.split("/").filter(Boolean)[0];
    const activeToolSlug = slug && navigationSlugs.includes(slug) ? slug : undefined;

    useEffect(() => {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(collapsed));
    }, [collapsed]);

    const toggleCollapsed = () => setCollapsed((value) => !value);
    const toggleOpen = (key: string) => setOpenKeys((keys) => (keys.includes(key) ? keys.filter((item) => item !== key) : [...keys, key]));

    return (
        <>
            <aside
                className="relative z-30 hidden h-dvh shrink-0 flex-col border-r border-border bg-background transition-[width] duration-200 md:flex"
                style={{ width: collapsed ? 68 : 244 }}
            >
                <div className={cn("flex h-16 shrink-0 items-center border-b border-border", collapsed ? "justify-center px-2" : "justify-between px-5")}>
                    <Link to="/" className={cn("flex min-w-0 items-center gap-2 text-foreground", collapsed && "justify-center")} aria-label={`${APP_NAME}首页`}>
                        <span className="size-6 shrink-0 bg-current" style={{ mask: "url(/logo.svg) center / contain no-repeat", WebkitMask: "url(/logo.svg) center / contain no-repeat" }} />
                        {!collapsed ? <span className="truncate text-base font-semibold tracking-tight">{APP_NAME}</span> : null}
                    </Link>
                    {!collapsed ? (
                        <button type="button" className="grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground transition hover:bg-muted hover:text-foreground" onClick={toggleCollapsed} aria-label="折叠导航" title="折叠导航">
                            <PanelLeftClose className="size-4" />
                        </button>
                    ) : null}
                </div>

                <nav className="thin-scrollbar min-h-0 flex-1 overflow-y-auto px-2 py-5" aria-label="主导航">
                    {navigationGroups.map((group) => (
                        <div key={group.label} className="mb-5 last:mb-0">
                            {!collapsed ? <div className="mb-2 px-3 text-xs font-semibold tracking-wide text-muted-foreground">{group.label}</div> : null}
                            <div className="space-y-1">
                                {group.items.map((item) => {
                                    const Icon = item.icon;
                                    const active = isItemActive(item, pathname);

                                    if (item.children?.length) {
                                        const open = openKeys.includes(item.key);
                                        return (
                                            <div key={item.key}>
                                                <Tooltip title={collapsed ? item.label : undefined} placement="right">
                                                    <button
                                                        type="button"
                                                        className="block w-full"
                                                        onClick={() => (collapsed && item.href ? navigate(item.href) : toggleOpen(item.key))}
                                                        aria-label={item.label}
                                                        title={collapsed ? item.label : undefined}
                                                    >
                                                        <span
                                                            className={cn(
                                                                "relative flex h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-sm transition",
                                                                collapsed ? "justify-center px-0" : "",
                                                                active ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground",
                                                            )}
                                                        >
                                                            <Icon className="size-5 shrink-0" />
                                                            {!collapsed ? <span className="min-w-0 flex-1 truncate">{item.label}</span> : null}
                                                            {!collapsed ? <ChevronRight className={cn("size-4 shrink-0 opacity-60 transition-transform duration-200", open ? "rotate-90" : undefined)} /> : null}
                                                            {active && collapsed ? <span className="absolute right-1 top-1/2 h-6 w-0.5 -translate-y-1/2 rounded-full bg-primary" /> : null}
                                                        </span>
                                                    </button>
                                                </Tooltip>
                                                {!collapsed && open ? (
                                                    <div className="mt-0.5 space-y-0.5">
                                                        {item.children.map((child) => {
                                                            const childActive = pathname === child.href || (pathname.startsWith(`${child.href}/`) && !item.children?.some((other) => other.href !== child.href && (pathname === other.href || pathname.startsWith(`${other.href}/`))));
                                                            return (
                                                                <Link
                                                                    key={child.key}
                                                                    to={child.href}
                                                                    className={cn(
                                                                        "flex h-9 items-center rounded-lg pl-11 pr-3 text-sm transition",
                                                                        childActive ? "font-medium text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground",
                                                                    )}
                                                                >
                                                                    {child.label}
                                                                </Link>
                                                            );
                                                        })}
                                                    </div>
                                                ) : null}
                                            </div>
                                        );
                                    }

                                    const content = (
                                        <span
                                            className={cn(
                                                "relative flex h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-sm transition",
                                                collapsed ? "justify-center px-0" : "",
                                                active ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground",
                                            )}
                                        >
                                            <Icon className="size-5 shrink-0" />
                                            {!collapsed ? <span className="min-w-0 flex-1 truncate">{item.label}</span> : null}
                                            {active ? <span className="absolute right-1 top-1/2 h-6 w-0.5 -translate-y-1/2 rounded-full bg-primary" /> : null}
                                        </span>
                                    );

                                    return (
                                        <Tooltip key={item.key} title={collapsed ? item.label : undefined} placement="right">
                                            {item.action === "agent" ? (
                                                <button type="button" className="block w-full" onClick={toggleAgent} aria-label={item.label} title={item.label}>
                                                    {content}
                                                </button>
                                            ) : (
                                                <Link to={item.href || "/"} aria-label={item.label} title={collapsed ? item.label : undefined}>
                                                    {content}
                                                </Link>
                                            )}
                                        </Tooltip>
                                    );
                                })}
                            </div>
                        </div>
                    ))}
                </nav>

                <div className="shrink-0 border-t border-border p-2">
                    {!collapsed ? <div className="mb-1 px-3 text-xs font-semibold tracking-wide text-muted-foreground">更多</div> : null}
                    <SidebarAction collapsed={collapsed} label="文档" icon={<BookOpen className="size-5" />} onClick={() => window.open(DOCS_URL, "_blank", "noopener,noreferrer")} />
                    <SidebarAction collapsed={collapsed} label="配置" icon={<Settings2 className="size-5" />} onClick={() => openConfigDialog(false, "preferences")} />
                    <Tooltip title={collapsed ? (theme === "dark" ? "切换到浅色主题" : "切换到深色主题") : undefined} placement="right">
                        <AnimatedThemeToggler
                            theme={theme}
                            onThemeChange={setTheme}
                            className={cn("flex h-11 w-full items-center rounded-xl text-sm text-muted-foreground transition hover:bg-muted hover:text-foreground", collapsed ? "justify-center px-0" : "gap-3 px-3")}
                            aria-label={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"}
                        >
                            {theme === "dark" ? <Sun className="size-5 shrink-0" /> : <Moon className="size-5 shrink-0" />}
                            {!collapsed ? <span>{theme === "dark" ? "浅色模式" : "深色模式"}</span> : null}
                        </AnimatedThemeToggler>
                    </Tooltip>
                    <div className="my-2 border-t border-border" />
                    <Dropdown
                        trigger={["click"]}
                        menu={{
                            items: [
                                ...(user?.role === "admin" ? [{ key: "admin", icon: <Shield className="size-4" />, label: "管理员控制台" }] : []),
                                { key: "logout", icon: <LogOut className="size-4" />, label: "退出登录", danger: true },
                            ],
                            onClick: async ({ key }) => {
                                if (key === "admin") navigate("/admin");
                                else {
                                    await logout();
                                    navigate("/login", { replace: true });
                                }
                            },
                        }}
                    >
                        <button type="button" className={cn("flex h-11 w-full items-center rounded-xl text-left text-sm text-muted-foreground transition hover:bg-muted hover:text-foreground", collapsed ? "justify-center px-0" : "gap-3 px-3")} aria-label="用户菜单" title={collapsed ? user?.username : undefined}>
                            <UserCircle className="size-5 shrink-0" />
                            {!collapsed ? <span className="min-w-0 flex-1 truncate">{user?.username}</span> : null}
                            {!collapsed ? <ChevronRight className="size-4 opacity-50" /> : null}
                        </button>
                    </Dropdown>
                    {collapsed ? (
                        <Tooltip title="展开导航" placement="right">
                            <button type="button" className="mt-1 grid h-11 w-full place-items-center rounded-xl text-muted-foreground transition hover:bg-muted hover:text-foreground" onClick={toggleCollapsed} aria-label="展开导航">
                                <PanelLeftOpen className="size-5" />
                            </button>
                        </Tooltip>
                    ) : null}
                </div>
            </aside>

            <div className="flex h-12 shrink-0 items-center justify-between border-b border-border bg-background px-3 md:hidden">
                <Link to="/" className="flex items-center gap-2 text-sm font-semibold text-foreground" aria-label={`${APP_NAME}首页`}>
                    <span className="size-5 bg-current" style={{ mask: "url(/logo.svg) center / contain no-repeat", WebkitMask: "url(/logo.svg) center / contain no-repeat" }} />
                    <span>{APP_NAME}</span>
                </Link>
                <div className="flex items-center gap-1">
                    <UserStatusActions />
                    <button type="button" className="grid size-8 place-items-center rounded-lg text-muted-foreground" onClick={toggleAgent} aria-label="打开 Agent">
                        <Bot className="size-5" />
                    </button>
                    <Dropdown
                        trigger={["click"]}
                        menu={{
                            items: [
                                ...(user?.role === "admin" ? [{ key: "admin", icon: <Shield className="size-4" />, label: "管理员控制台" }] : []),
                                { key: "logout", icon: <LogOut className="size-4" />, label: "退出登录", danger: true },
                            ],
                            onClick: async ({ key }) => {
                                if (key === "admin") navigate("/admin");
                                else {
                                    await logout();
                                    navigate("/login", { replace: true });
                                }
                            },
                        }}
                    >
                        <button type="button" className="grid size-8 place-items-center rounded-lg text-muted-foreground" aria-label="用户菜单">
                            <UserCircle className="size-5" />
                        </button>
                    </Dropdown>
                    <button type="button" className="grid size-8 place-items-center rounded-lg text-muted-foreground" onClick={() => setMobileNavOpen(true)} aria-label="打开导航菜单">
                        <Menu className="size-5" />
                    </button>
                </div>
            </div>
            <MobileNavDrawer open={mobileNavOpen} activeToolSlug={activeToolSlug} onClose={() => setMobileNavOpen(false)} onToggleAgent={toggleAgent} />
        </>
    );
}

function SidebarAction({ collapsed, label, icon, onClick }: { collapsed: boolean; label: string; icon: React.ReactNode; onClick: () => void }) {
    const content = (
        <span className={cn("flex h-11 w-full items-center rounded-xl text-sm text-muted-foreground transition hover:bg-muted hover:text-foreground", collapsed ? "justify-center px-0" : "gap-3 px-3")}>
            {icon}
            {!collapsed ? <span>{label}</span> : null}
        </span>
    );
    return (
        <Tooltip title={collapsed ? label : undefined} placement="right">
            <button type="button" className="block w-full" onClick={onClick} aria-label={label} title={collapsed ? label : undefined}>
                {content}
            </button>
        </Tooltip>
    );
}

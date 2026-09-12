import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { Drawer } from "antd";
import { Link, useLocation } from "react-router-dom";

import { navigationGroups, type NavigationItem, type NavigationToolSlug } from "@/constant/navigation-tools";
import { cn } from "@/lib/utils";

type MobileNavDrawerProps = {
    open: boolean;
    activeToolSlug?: NavigationToolSlug;
    onClose: () => void;
    onToggleAgent?: () => void;
};

function isItemActive(item: NavigationItem, pathname: string) {
    if (item.children?.length) {
        return item.children.some((child) => pathname === child.href || pathname.startsWith(`${child.href}/`));
    }
    return false;
}

export function MobileNavDrawer({ open, activeToolSlug, onClose, onToggleAgent }: MobileNavDrawerProps) {
    const { pathname } = useLocation();
    const [openKeys, setOpenKeys] = useState<string[]>(() =>
        navigationGroups.flatMap((group) =>
            group.items
                .filter((item) => item.children?.some((child) => pathname === child.href || pathname.startsWith(`${child.href}/`)))
                .map((item) => item.key),
        ),
    );
    const toggleOpen = (key: string) => setOpenKeys((keys) => (keys.includes(key) ? keys.filter((item) => item !== key) : [...keys, key]));

    return (
        <Drawer title="导航" placement="left" size={280} open={open} onClose={onClose} className="md:hidden">
            <div className="space-y-5">
                {navigationGroups.map((group) => (
                    <div key={group.label}>
                        <div className="mb-2 px-3 text-xs font-semibold tracking-wide text-muted-foreground">{group.label}</div>
                        <div className="space-y-1">
                            {group.items.map((item) => {
                                const Icon = item.icon;

                                if (item.children?.length) {
                                    const openKey = openKeys.includes(item.key);
                                    const active = isItemActive(item, pathname);
                                    return (
                                        <div key={item.key}>
                                            <button
                                                type="button"
                                                onClick={() => toggleOpen(item.key)}
                                                className={cn(
                                                    "flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left text-base transition",
                                                    active ? "font-medium text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground",
                                                )}
                                            >
                                                <Icon className="size-5" />
                                                <span className="min-w-0 flex-1">{item.label}</span>
                                                <ChevronRight className={cn("size-4 shrink-0 opacity-60 transition-transform duration-200", openKey ? "rotate-90" : undefined)} />
                                            </button>
                                            {openKey ? (
                                                <div className="mt-0.5 space-y-0.5">
                                                    {item.children.map((child) => {
                                                        const childActive = pathname === child.href || pathname.startsWith(`${child.href}/`);
                                                        return (
                                                            <Link
                                                                key={child.key}
                                                                to={child.href}
                                                                onClick={onClose}
                                                                className={cn(
                                                                    "block rounded-lg py-2.5 pl-11 pr-3 text-base transition",
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

                                const active = item.href ? (item.href === "/canvas" ? activeToolSlug === "canvas" : item.href.slice(1) === activeToolSlug) : false;
                                if (item.action === "agent") {
                                    return (
                                        <button
                                            key={item.key}
                                            type="button"
                                            onClick={() => {
                                                onToggleAgent?.();
                                                onClose();
                                            }}
                                            className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left text-base text-muted-foreground transition hover:bg-muted hover:text-foreground"
                                        >
                                            <Icon className="size-5" />
                                            <span>{item.label}</span>
                                        </button>
                                    );
                                }
                                return (
                                    <Link
                                        key={item.key}
                                        to={item.href || "/"}
                                        onClick={onClose}
                                        className={cn(
                                            "flex items-center gap-3 rounded-lg px-3 py-3 text-base transition",
                                            active ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground",
                                        )}
                                    >
                                        <Icon className="size-5" />
                                        <span>{item.label}</span>
                                    </Link>
                                );
                            })}
                        </div>
                    </div>
                ))}
            </div>
        </Drawer>
    );
}

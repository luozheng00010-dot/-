import { Moon, Sun } from "lucide-react";

import { cn } from "@/lib/utils";

export type TransitionVariant = "circle" | "square" | "triangle" | "diamond" | "hexagon" | "rectangle" | "star";

interface AnimatedThemeTogglerProps extends React.ComponentPropsWithoutRef<"button"> {
    duration?: number;
    variant?: TransitionVariant;
    /** Retained for compatibility with existing callers. */
    fromCenter?: boolean;
    theme?: "light" | "dark";
    targetTheme?: "light" | "dark";
    onThemeChange?: (theme: "light" | "dark") => void;
}

export const AnimatedThemeToggler = ({ children, className, theme, targetTheme, onThemeChange, ...props }: AnimatedThemeTogglerProps) => {
    const currentTheme = theme ?? "light";
    const nextTheme = targetTheme ?? (currentTheme === "dark" ? "light" : "dark");

    return (
        <button
            type="button"
            onClick={() => onThemeChange?.(nextTheme)}
            className={cn(className)}
            {...props}
        >
            {children ?? (currentTheme === "dark" ? <Sun /> : <Moon />)}
            <span className="sr-only">{props["aria-label"] || "切换主题"}</span>
        </button>
    );
};

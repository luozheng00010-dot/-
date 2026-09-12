import { useEffect, useId, useMemo, useState } from "react";
import { App, Tooltip } from "antd";
import { Cpu, RefreshCw } from "lucide-react";

import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { loadServerModelChannels, modelOptionLabel, modelOptionName, selectableModelsByCapability, useConfigStore, type AiConfig, type ModelCapability } from "@/stores/use-config-store";

type ModelPickerProps = {
    config: AiConfig;
    value?: string;
    onChange: (model: string) => void;
    capability?: ModelCapability;
    className?: string;
    fullWidth?: boolean;
    placeholder?: string;
    onMissingConfig?: () => void;
};

export function ModelPicker({ config, value, onChange, capability, className, fullWidth = false, placeholder = "选择模型", onMissingConfig }: ModelPickerProps) {
    const { message } = App.useApp();
    const pickerId = useId();
    const [open, setOpen] = useState(false);
    const refreshing = useConfigStore((state) => state.isRefreshingServerChannels);
    const options = useMemo(() => Array.from(new Set([...(config.channelMode === "local" && !capability ? [value] : []), ...selectableModelsByCapability(config, capability)].filter((model): model is string => Boolean(model)))), [capability, config, value]);
    const current = value || "";

    useEffect(() => {
        const closeOtherPicker = (event: Event) => {
            if ((event as CustomEvent<string>).detail !== pickerId) setOpen(false);
        };
        window.addEventListener("model-picker-open", closeOtherPicker);
        return () => window.removeEventListener("model-picker-open", closeOtherPicker);
    }, [pickerId]);

    const refreshServerModels = async () => {
        try {
            await loadServerModelChannels();
            message.success("管理员模型已刷新");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "管理员模型刷新失败");
        }
    };

    return (
        <div className={cn("flex min-w-0 max-w-full items-center gap-1", fullWidth && "w-full")}>
            <Select
                open={open}
                value={current}
                onOpenChange={(nextOpen) => {
                    if (nextOpen && !options.length && config.channelMode === "local") onMissingConfig?.();
                    if (nextOpen) window.dispatchEvent(new CustomEvent("model-picker-open", { detail: pickerId }));
                    setOpen(nextOpen);
                }}
                onValueChange={onChange}
            >
                <SelectTrigger
                    className={cn(
                        "canvas-composer-model-picker h-8 w-fit max-w-full gap-2 rounded-full border border-input bg-transparent px-3 text-sm font-normal shadow-sm transition-colors",
                        fullWidth ? "min-w-0 flex-1 justify-start" : "min-w-[9rem] justify-start",
                        "data-[state=open]:border-ring data-[state=open]:ring-2 data-[state=open]:ring-ring/20",
                        className,
                    )}
                    onMouseDown={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                    title={current ? modelOptionLabel(config, current) : placeholder}
                >
                    <ModelIcon model={current} />
                    <span className="canvas-model-picker-text min-w-0 flex-1 truncate text-left">{current ? modelOptionLabel(config, current) : placeholder}</span>
                </SelectTrigger>
                <SelectContent
                    data-canvas-no-zoom
                    className="z-[1200] w-80 max-w-[calc(100vw-24px)] rounded-xl border border-border/70 bg-popover p-1 shadow-xl"
                    position="popper"
                    align="start"
                    side="bottom"
                    sideOffset={6}
                    onPointerDown={(event) => event.stopPropagation()}
                    onMouseDown={(event) => event.stopPropagation()}
                >
                    {options.length ? (
                        options.map((model) => (
                            <SelectItem key={model} value={model} textValue={modelOptionLabel(config, model)}>
                                <ModelLabel config={config} model={model} />
                            </SelectItem>
                        ))
                    ) : (
                        <SelectItem value="__empty__" disabled>
                            {emptyModelLabel(config, capability)}
                        </SelectItem>
                    )}
                </SelectContent>
            </Select>
            <Tooltip title="刷新管理员模型">
                <button
                    type="button"
                    data-canvas-no-zoom
                    className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition hover:bg-black/5 hover:text-foreground disabled:cursor-wait disabled:opacity-50 dark:hover:bg-white/10"
                    disabled={refreshing}
                    aria-label="刷新管理员模型"
                    onMouseDown={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                        event.stopPropagation();
                        void refreshServerModels();
                    }}
                >
                    <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} />
                </button>
            </Tooltip>
        </div>
    );
}

function emptyModelLabel(config: AiConfig, capability?: ModelCapability) {
    const label = capability === "image" ? "生图" : capability === "video" ? "视频" : capability === "text" ? "文本" : capability === "audio" ? "音频" : "";
    if (capability && config.models.length) return `请先在渠道里为${label}指定模型`;
    return config.models.length ? `暂无匹配的${label}模型` : "请先到配置里添加渠道和模型";
}

function ModelLabel({ config, model }: { config: AiConfig; model: string }) {
    return (
        <span className="flex min-w-0 items-center gap-2">
            <ModelIcon model={model} />
            <span className="truncate">{modelOptionLabel(config, model)}</span>
        </span>
    );
}

function ModelIcon({ model }: { model: string }) {
    const icon = resolveModelIcon(modelOptionName(model));
    return icon ? <img src={icon} alt="" className="size-4 shrink-0 dark:invert" /> : <Cpu className="size-4 shrink-0 opacity-70" />;
}

function resolveModelIcon(model: string) {
    const name = model.toLowerCase();
    if (name.includes("claude") || name.includes("anthropic")) return "/icons/claude.svg";
    if (name.includes("gemini") || name.includes("google")) return "/icons/gemini.svg";
    if (name.includes("gpt") || name.includes("openai")) return "/icons/openai.svg";
    if (name.includes("grok") || name.includes("grok")) return "/icons/grok.svg";
    if (name.includes("deepseek") || name.includes("deepseek")) return "/icons/deepseek.svg";
    if (name.includes("glm") || name.includes("glm")) return "/icons/glm.svg";
    return "";
}

import { useCallback, useEffect, useState } from "react";
import { App, Button, Input, Select } from "antd";
import { Plus, X } from "lucide-react";
import { createVideoSku, deleteVideoSku, listVideoSkus } from "../api";
import type { VideoSku } from "../types";

/**
 * 货号下拉选择（模块内共享）：受控组件，值是货号名（后端接口收名字，不是 id）。
 * 下拉底部带"空白输入框 + 新增按钮"；选项右侧显示素材数与删除入口。
 * "通用"是哨兵值不参与货号管理，列表数据即 GET /skus 的返回（服务端已排除）。
 */
export interface SkuSelectProps {
    value?: string | null;
    onChange?: (name: string | null) => void;
    disabled?: boolean;
    placeholder?: string;
    /** 透传给 Select 根节点，用于控制宽度（如 "w-52" / "flex-1"） */
    className?: string;
}

export default function SkuSelect({ value, onChange, disabled, placeholder = "选择或新增货号", className }: SkuSelectProps) {
    const { message, modal } = App.useApp();
    const [skus, setSkus] = useState<VideoSku[]>([]);
    const [newName, setNewName] = useState("");
    const [creating, setCreating] = useState(false);

    const refresh = useCallback(async () => {
        try {
            const result = await listVideoSkus();
            setSkus(result.skus);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "货号加载失败");
        }
    }, [message]);

    useEffect(() => { void refresh(); }, [refresh]);

    const submitNew = async () => {
        const name = newName.trim();
        if (!name) {
            message.warning("请输入货号");
            return;
        }
        setCreating(true);
        try {
            const result = await createVideoSku(name);
            message.success(`货号「${result.sku.name}」已添加`);
            setNewName("");
            await refresh();
            onChange?.(result.sku.name);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "添加货号失败");
        } finally {
            setCreating(false);
        }
    };

    const confirmDelete = (sku: VideoSku) => {
        modal.confirm({
            title: "删除货号",
            content: sku.materialCount > 0
                ? `货号「${sku.name}」下还有 ${sku.materialCount} 条素材，服务端将拒绝删除，确定继续？`
                : `确定删除货号「${sku.name}」？删除后需要重新添加才能使用。`,
            okText: "删除",
            okButtonProps: { danger: true },
            cancelText: "取消",
            onOk: async () => {
                try {
                    await deleteVideoSku(sku.id);
                    message.success(`货号「${sku.name}」已删除`);
                    if (value === sku.name) onChange?.(null);
                    await refresh();
                } catch (error) {
                    // 400 时展示服务端文案（如"该货号下还有 N 条视频素材，无法删除"）
                    message.error(error instanceof Error ? error.message : "删除货号失败");
                }
            },
        });
    };

    return (
        <Select
            className={className}
            placeholder={placeholder}
            value={value ?? undefined}
            disabled={disabled}
            showSearch
            allowClear
            optionFilterProp="label"
            options={skus.map((sku) => ({ value: sku.name, label: sku.name }))}
            optionRender={(option) => {
                const sku = skus.find((item) => item.name === option.value);
                if (!sku) return option.label as React.ReactNode;
                return (
                    <span className="flex items-center gap-1">
                        <span className="min-w-0 flex-1 truncate">{sku.name}</span>
                        <span className="shrink-0 text-xs text-muted-foreground">（{sku.materialCount}）</span>
                        <X
                            aria-label={`删除货号 ${sku.name}`}
                            className="size-3.5 shrink-0 cursor-pointer text-muted-foreground transition hover:text-red-500"
                            onClick={(event) => { event.stopPropagation(); event.preventDefault(); confirmDelete(sku); }}
                        />
                    </span>
                );
            }}
            popupRender={(menu) => (
                <>
                    {menu}
                    <div className="flex items-center gap-2 border-t border-border px-2 py-2" onMouseDown={(event) => event.preventDefault()}>
                        <Input
                            size="small"
                            placeholder="新增货号"
                            value={newName}
                            maxLength={100}
                            disabled={creating}
                            onChange={(event) => setNewName(event.target.value)}
                            onPressEnter={() => void submitNew()}
                            onKeyDown={(event) => event.stopPropagation()}
                        />
                        <Button size="small" type="primary" icon={<Plus className="size-3.5" />} loading={creating} onClick={() => void submitNew()} />
                    </div>
                </>
            )}
            notFoundContent="暂无货号，可在下方输入框新增"
        />
    );
}

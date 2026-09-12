import { Button, Dropdown, Tag } from "antd";
import { ChevronDown, Users } from "lucide-react";
import { useEffect } from "react";
import { useAuthStore } from "@/stores/use-auth-store";
import { useOwnerScopeStore, type OwnerScope } from "@/stores/use-owner-scope-store";

export function OwnerScopePicker({ onChange }: { onChange?: (scope: OwnerScope) => void }) {
    const user = useAuthStore((state) => state.user);
    const scope = useOwnerScopeStore((state) => state.scope);
    const members = useOwnerScopeStore((state) => state.members);
    const loadMembers = useOwnerScopeStore((state) => state.loadMembers);
    const setScope = useOwnerScopeStore((state) => state.setScope);
    useEffect(() => { void loadMembers(); }, [loadMembers]);
    const selected = scope === "self" ? members.find((item) => item.isSelf) : members.find((item) => item.id === scope);
    const label = scope === "all" ? "全部成员" : selected?.username || user?.username || "我的数据";
    const select = (next: OwnerScope) => { setScope(next); onChange?.(next); };
    return <Dropdown trigger={["click"]} menu={{ items: [
        { key: "self", label: <div className="flex min-w-48 items-center justify-between gap-3"><span>{user?.username || "我"}（我）</span><Tag color="green">可编辑</Tag></div> },
        ...members.filter((item) => !item.isSelf).map((item) => ({ key: item.id, label: <div className="flex min-w-48 items-center justify-between gap-3"><span>{item.username}</span><Tag color={item.accessLevel === "edit" ? "green" : "blue"}>{item.accessLevel === "edit" ? "可编辑" : "可查看"}</Tag></div> })),
        { type: "divider" as const },
        { key: "all", label: <div className="flex items-center gap-2"><Users className="size-4" />全部</div> },
    ], onClick: ({ key }) => select(key as OwnerScope) }}>
        <Button icon={<Users className="size-4" />}>{label}<ChevronDown className="ml-1 size-3.5" /></Button>
    </Dropdown>;
}

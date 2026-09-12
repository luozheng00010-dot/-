import { App, Button, Form, Input, Modal, Select, Space, Switch, Table, Tabs, Tag } from "antd";
import { KeyRound, Plus, RefreshCw, Settings2, Trash2, UserCog } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Navigate } from "react-router-dom";
import { serverApi } from "@/services/server-api";
import { useAuthStore } from "@/stores/use-auth-store";
import { useOwnerScopeStore } from "@/stores/use-owner-scope-store";
import { guessCapability, loadServerModelChannels } from "@/stores/use-config-store";

type Grant = { targetUserId: string; level: "view" | "edit" };
type AdminUser = { id: string; username: string; role: "admin" | "member"; deletedAt?: string | null; permissions: Grant[] };
type AdminChannel = { id: string; name: string; baseUrl: string; apiFormat: "openai" | "gemini" | "ark"; apiKeyMasked: string; enabled: boolean; models: Array<{ name: string; capability: string; enabled: boolean }> };

type ChannelForm = { name: string; baseUrl: string; apiFormat: "openai" | "gemini" | "ark"; apiKey?: string; enabled: boolean; modelsText: string };

export default function AdminPage() {
    const { message, modal } = App.useApp();
    const user = useAuthStore((state) => state.user);
    const reloadMembers = useOwnerScopeStore((state) => state.loadMembers);
    const [users, setUsers] = useState<AdminUser[]>([]);
    const [channels, setChannels] = useState<AdminChannel[]>([]);
    const [loading, setLoading] = useState(false);
    const [createOpen, setCreateOpen] = useState(false);
    const [permissionUser, setPermissionUser] = useState<AdminUser | null>(null);
    const [resetUser, setResetUser] = useState<AdminUser | null>(null);
    const [channel, setChannel] = useState<AdminChannel | null | undefined>(undefined);
    const [fetchingModels, setFetchingModels] = useState(false);
    const [createForm] = Form.useForm();
    const [resetForm] = Form.useForm();
    const [channelForm] = Form.useForm<ChannelForm>();
    const [grants, setGrants] = useState<Record<string, "view" | "edit" | undefined>>({});
    const modelsText = Form.useWatch("modelsText", channelForm) || "";
    const modelLines = modelsText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

    const load = async () => {
        setLoading(true);
        try {
            const [userResult, channelResult] = await Promise.all([serverApi<{ users: AdminUser[] }>("/api/admin/users"), serverApi<{ channels: AdminChannel[] }>("/api/admin/channels")]);
            setUsers(userResult.users); setChannels(channelResult.channels);
        } catch (error) { message.error(error instanceof Error ? error.message : "读取管理数据失败"); }
        finally { setLoading(false); }
    };
    useEffect(() => { if (user?.role === "admin") void load(); }, [user?.role]);
    const activeMembers = useMemo(() => users.filter((item) => !item.deletedAt), [users]);
    if (user?.role !== "admin") return <Navigate to="/canvas" replace />;

    const openPermissions = (item: AdminUser) => {
        setPermissionUser(item);
        setGrants(Object.fromEntries(item.permissions.map((grant) => [grant.targetUserId, grant.level])));
    };
    const savePermissions = async () => {
        if (!permissionUser) return;
        await serverApi(`/api/admin/users/${permissionUser.id}/permissions`, { method: "PUT", body: JSON.stringify({ grants: Object.entries(grants).filter((entry): entry is [string, "view" | "edit"] => Boolean(entry[1])).map(([targetUserId, level]) => ({ targetUserId, level })) }) });
        message.success("权限已保存"); setPermissionUser(null); await Promise.all([load(), reloadMembers()]);
    };
    const openChannel = (item: AdminChannel | null) => {
        setChannel(item);
        channelForm.setFieldsValue(item ? { name: item.name, baseUrl: item.baseUrl, apiFormat: item.apiFormat, apiKey: "", enabled: item.enabled, modelsText: item.models.map((model) => `${model.capability}:${model.name}`).join("\n") } : { name: "", baseUrl: "https://api.openai.com", apiFormat: "openai", apiKey: "", enabled: true, modelsText: "image:gpt-image-1\ntext:gpt-4.1" });
    };
    const refreshWebsiteModels = async () => {
        try { await loadServerModelChannels({ force: true }); }
        catch (error) { message.warning(`渠道变更已完成，但网站模型同步失败：${error instanceof Error ? error.message : "请稍后手动刷新"}`); }
    };
    const saveChannel = async (values: ChannelForm) => {
        const models = values.modelsText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => { const [capability, ...name] = line.split(":"); return { capability, name: name.join(":").trim(), enabled: true }; }).filter((item) => ["image", "video", "text", "audio"].includes(item.capability) && item.name);
        const body = { ...values, modelsText: undefined, apiKey: values.apiKey || undefined, models };
        await serverApi(channel ? `/api/admin/channels/${channel.id}` : "/api/admin/channels", { method: channel ? "PUT" : "POST", body: JSON.stringify(body) });
        message.success(channel ? "渠道已更新" : "渠道已创建"); setChannel(undefined); await Promise.all([load(), refreshWebsiteModels()]);
    };
    const fetchModels = async () => {
        try {
            const values = await channelForm.validateFields(["baseUrl", "apiFormat", "apiKey"]);
            setFetchingModels(true);
            const result = await serverApi<{ models: string[] }>("/api/admin/channels/fetch-models", { method: "POST", body: JSON.stringify({ channelId: channel?.id, baseUrl: values.baseUrl, apiFormat: values.apiFormat, apiKey: values.apiKey || undefined }) });
            const existing = new Map((channelForm.getFieldValue("modelsText") || "").split(/\r?\n/).map((line: string) => line.trim()).filter(Boolean).map((line: string) => { const [, ...name] = line.split(":"); return [name.join(":").trim(), line] as const; }));
            channelForm.setFieldValue("modelsText", result.models.map((name) => existing.get(name) || `${guessCapability(name)}:${name}`).join("\n"));
            message.success(`已获取 ${result.models.length} 个模型`);
        } catch (error) {
            if (error && typeof error === "object" && "errorFields" in error) return;
            message.error(error instanceof Error ? error.message : "获取模型失败");
        } finally {
            setFetchingModels(false);
        }
    };
    const removeChannelModel = (index: number) => {
        const next = [...modelLines];
        next.splice(index, 1);
        channelForm.setFieldValue("modelsText", next.join("\n"));
    };

    return <main className="h-full overflow-auto"><div className="mx-auto max-w-7xl p-6">
        <div className="mb-6"><h1 className="text-2xl font-semibold">管理员控制台</h1><p className="mt-1 text-sm text-stone-500">管理成员权限和全局模型渠道</p></div>
        <Tabs items={[
            { key: "users", label: "账号与权限", children: <>
                <div className="mb-4 flex justify-end"><Button type="primary" icon={<Plus className="size-4" />} onClick={() => setCreateOpen(true)}>创建账号</Button></div>
                <Table rowKey="id" loading={loading} dataSource={users} pagination={false} columns={[
                    { title: "账号", dataIndex: "username", render: (value, item) => <Space>{value}{item.role === "admin" && <Tag color="gold">管理员</Tag>}{item.deletedAt && <Tag>已停用</Tag>}</Space> },
                    { title: "可访问成员", render: (_, item) => item.role === "admin" ? "全部" : item.permissions.length ? `${item.permissions.length} 人` : "仅本人" },
                    { title: "操作", render: (_, item) => item.role === "admin" ? null : <Space wrap>
                        <Button size="small" icon={<UserCog className="size-3.5" />} onClick={() => openPermissions(item)}>权限</Button>
                        <Button size="small" icon={<KeyRound className="size-3.5" />} onClick={() => { setResetUser(item); resetForm.resetFields(); }}>重置密码</Button>
                        {item.deletedAt ? <Button size="small" icon={<RefreshCw className="size-3.5" />} onClick={async () => { await serverApi(`/api/admin/users/${item.id}/restore`, { method: "POST" }); await load(); }}>恢复</Button> : <Button danger size="small" icon={<Trash2 className="size-3.5" />} onClick={() => modal.confirm({ title: `停用账号 ${item.username}？`, content: "账号将无法登录，数据会继续保留。", okButtonProps: { danger: true }, onOk: async () => { await serverApi(`/api/admin/users/${item.id}`, { method: "DELETE" }); await Promise.all([load(), reloadMembers()]); } })}>停用</Button>}
                    </Space> },
                ]} />
            </> },
            { key: "channels", label: "模型渠道", children: <>
                <div className="mb-4 flex justify-end"><Button type="primary" icon={<Plus className="size-4" />} onClick={() => openChannel(null)}>添加渠道</Button></div>
                <Table rowKey="id" loading={loading} dataSource={channels} pagination={false} columns={[
                    { title: "名称", dataIndex: "name" }, { title: "协议", dataIndex: "apiFormat" }, { title: "Base URL", dataIndex: "baseUrl" }, { title: "模型", render: (_, item) => item.models.length }, { title: "状态", render: (_, item) => <Tag color={item.enabled ? "green" : "default"}>{item.enabled ? "启用" : "停用"}</Tag> },
                    { title: "操作", render: (_, item) => <Space><Button size="small" icon={<Settings2 className="size-3.5" />} onClick={() => openChannel(item)}>编辑</Button><Button danger size="small" onClick={() => modal.confirm({ title: `删除渠道 ${item.name}？`, onOk: async () => { await serverApi(`/api/admin/channels/${item.id}`, { method: "DELETE" }); await Promise.all([load(), refreshWebsiteModels()]); } })}>删除</Button></Space> },
                ]} />
            </> },
        ]} />
        <Modal open={createOpen} title="创建账号" footer={null} onCancel={() => setCreateOpen(false)} destroyOnHidden>
            <Form form={createForm} layout="vertical" onFinish={async (values) => { try { await serverApi("/api/admin/users", { method: "POST", body: JSON.stringify(values) }); message.success("账号已创建"); setCreateOpen(false); createForm.resetFields(); await load(); } catch (error) { message.error(error instanceof Error ? error.message : "创建失败"); } }}>
                <Form.Item name="username" label="账号名" extra="1-10 个中文或英文字母" rules={[{ required: true }, { pattern: /^[\p{Script=Han}A-Za-z]{1,10}$/u, message: "仅允许 1-10 个中文或英文字母" }]}><Input maxLength={10} /></Form.Item>
                <Form.Item name="password" label="初始密码" rules={[{ required: true }, { min: 8, max: 72 }]}><Input.Password /></Form.Item>
                <Button type="primary" htmlType="submit" block>创建</Button>
            </Form>
        </Modal>
        <Modal open={Boolean(permissionUser)} title={permissionUser ? `配置 ${permissionUser.username} 的权限` : "权限"} onCancel={() => setPermissionUser(null)} onOk={() => void savePermissions()}>
            <div className="grid gap-3">{activeMembers.filter((item) => item.id !== permissionUser?.id).map((item) => <div key={item.id} className="flex items-center justify-between rounded-lg border border-stone-200 px-3 py-2 dark:border-stone-800"><span>{item.username}</span><Select className="w-28" value={grants[item.id] || "none"} options={[{ value: "none", label: "无权限" }, { value: "view", label: "可查看" }, { value: "edit", label: "可编辑" }]} onChange={(value) => setGrants((current) => ({ ...current, [item.id]: value === "none" ? undefined : value as "view" | "edit" }))} /></div>)}</div>
        </Modal>
        <Modal open={Boolean(resetUser)} title={resetUser ? `重置 ${resetUser.username} 的密码` : "重置密码"} footer={null} onCancel={() => setResetUser(null)}>
            <Form form={resetForm} layout="vertical" onFinish={async ({ password }) => { await serverApi(`/api/admin/users/${resetUser!.id}/reset-password`, { method: "POST", body: JSON.stringify({ password }) }); message.success("密码已重置，用户下次登录必须修改"); setResetUser(null); }}><Form.Item name="password" label="新密码" rules={[{ required: true }, { min: 8, max: 72 }]}><Input.Password /></Form.Item><Button type="primary" htmlType="submit" block>重置</Button></Form>
        </Modal>
        <Modal open={channel !== undefined} title={channel ? "编辑模型渠道" : "添加模型渠道"} footer={null} onCancel={() => setChannel(undefined)} destroyOnHidden>
            <Form form={channelForm} layout="vertical" onFinish={(values) => void saveChannel(values)}>
                <Form.Item name="name" label="渠道名称" rules={[{ required: true }]}><Input /></Form.Item>
                <Form.Item name="apiFormat" label="协议" rules={[{ required: true }]}><Select options={[{ value: "openai", label: "OpenAI" }, { value: "gemini", label: "Gemini" }, { value: "ark", label: "火山方舟" }]} /></Form.Item>
                <Form.Item name="baseUrl" label="Base URL" rules={[{ required: true }, { type: "url" }]}><Input /></Form.Item>
                <Form.Item name="apiKey" label={channel ? "API Key（留空保持不变）" : "API Key"} rules={channel ? [] : [{ required: true }]}><Input.Password /></Form.Item>
                <Form.Item label="模型列表" extra="每行 capability:model，例如 image:gpt-image-1；可单独删除模型，保存后立即生效">
                    <div className="mb-2 flex justify-end"><Button size="small" icon={<RefreshCw className="size-3.5" />} loading={fetchingModels} onClick={() => void fetchModels()}>获取模型</Button></div>
                    <Form.Item name="modelsText" noStyle><Input.TextArea autoSize={{ minRows: 4, maxRows: 10 }} /></Form.Item>
                    {modelLines.length ? <div className="mt-2 space-y-1 rounded-lg border border-stone-200 p-2 dark:border-stone-800">
                        {modelLines.map((line, index) => <div key={`${index}-${line}`} className="flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-stone-50 dark:hover:bg-stone-900/40"><span className="min-w-0 flex-1 truncate" title={line}>{line}</span><Button type="text" danger size="small" icon={<Trash2 className="size-3.5" />} aria-label={`删除模型 ${line}`} onClick={() => removeChannelModel(index)} /></div>)}
                    </div> : <div className="mt-2 rounded-lg border border-dashed border-stone-200 px-3 py-3 text-center text-xs text-stone-500 dark:border-stone-800">当前渠道没有模型，保存后可重新添加。</div>}
                </Form.Item>
                <Form.Item name="enabled" label="启用" valuePropName="checked"><Switch /></Form.Item>
                <Button type="primary" htmlType="submit" block>保存</Button>
            </Form>
        </Modal>
    </div></main>;
}

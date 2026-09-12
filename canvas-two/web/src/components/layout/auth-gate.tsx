import { App, Button, Form, Input, Modal, Spin } from "antd";
import { useEffect, useState, type ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuthStore } from "@/stores/use-auth-store";
import { useOwnerScopeStore } from "@/stores/use-owner-scope-store";
import { loadServerModelChannels, useConfigStore } from "@/stores/use-config-store";
import { LegacyMigrationPrompt } from "@/components/layout/legacy-migration-prompt";

export function AuthGate({ children }: { children: ReactNode }) {
    const { message } = App.useApp();
    const location = useLocation();
    const user = useAuthStore((state) => state.user);
    const initialized = useAuthStore((state) => state.initialized);
    const loadSession = useAuthStore((state) => state.loadSession);
    const changePassword = useAuthStore((state) => state.changePassword);
    const loadMembers = useOwnerScopeStore((state) => state.loadMembers);
    const [saving, setSaving] = useState(false);

    useEffect(() => { if (!initialized) void loadSession(); }, [initialized, loadSession]);
    useEffect(() => {
        if (user && !user.mustChangePassword) void Promise.all([loadMembers(), loadServerModelChannels()]);
        else useConfigStore.setState({ serverChannels: [] });
    }, [loadMembers, user]);

    if (!initialized) return <div className="flex h-dvh items-center justify-center"><Spin size="large" /></div>;
    if (!user) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;

    return <>
        {children}
        <LegacyMigrationPrompt />
        <Modal open={user.mustChangePassword} title="首次登录请修改密码" closable={false} footer={null} maskClosable={false}>
            <Form layout="vertical" onFinish={async (values: { currentPassword: string; newPassword: string; confirmPassword: string }) => {
                if (values.newPassword !== values.confirmPassword) return message.error("两次输入的新密码不一致");
                setSaving(true);
                try { await changePassword(values.currentPassword, values.newPassword); message.success("密码修改成功"); }
                catch (error) { message.error(error instanceof Error ? error.message : "修改失败"); }
                finally { setSaving(false); }
            }}>
                <Form.Item name="currentPassword" label="当前密码" rules={[{ required: true }]}><Input.Password autoComplete="current-password" /></Form.Item>
                <Form.Item name="newPassword" label="新密码" rules={[{ required: true }, { min: 8, max: 72 }]}><Input.Password autoComplete="new-password" /></Form.Item>
                <Form.Item name="confirmPassword" label="确认新密码" rules={[{ required: true }]}><Input.Password autoComplete="new-password" /></Form.Item>
                <Button htmlType="submit" type="primary" block loading={saving}>保存新密码</Button>
            </Form>
        </Modal>
    </>;
}

import { App, Button, Form, Input } from "antd";
import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { APP_NAME } from "@/constant/app";
import { useAuthStore } from "@/stores/use-auth-store";

const usernamePattern = /^[\p{Script=Han}A-Za-z]{1,10}$/u;

export default function LoginPage() {
    const { message } = App.useApp();
    const navigate = useNavigate();
    const location = useLocation();
    const user = useAuthStore((state) => state.user);
    const initialized = useAuthStore((state) => state.initialized);
    const loadSession = useAuthStore((state) => state.loadSession);
    const login = useAuthStore((state) => state.login);
    const [loading, setLoading] = useState(false);
    useEffect(() => { if (!initialized) void loadSession(); }, [initialized, loadSession]);
    useEffect(() => { if (user) navigate((location.state as { from?: string } | null)?.from || "/", { replace: true }); }, [location.state, navigate, user]);
    return <div className="flex min-h-dvh items-center justify-center bg-stone-100 px-4 dark:bg-stone-950">
        <div className="w-full max-w-sm rounded-2xl border border-stone-200 bg-white p-7 shadow-xl dark:border-stone-800 dark:bg-stone-900">
            <div className="mb-6 text-center"><div className="flex items-center justify-center gap-2"><div className="size-10 shrink-0 bg-stone-950 dark:bg-white" style={{ mask: "url(/logo.svg) center / contain no-repeat", WebkitMask: "url(/logo.svg) center / contain no-repeat" }} /><h1 className="text-xl font-semibold">{APP_NAME}</h1></div><p className="mt-1 text-sm text-stone-500">使用管理员分配的账号登录</p></div>
            <Form layout="vertical" onFinish={async (values: { username: string; password: string }) => {
                setLoading(true); try { await login(values.username, values.password); } catch (error) { message.error(error instanceof Error ? error.message : "登录失败"); } finally { setLoading(false); }
            }}>
                <Form.Item name="username" label="账号" rules={[{ required: true, message: "请输入账号" }, { pattern: usernamePattern, message: "账号名必须为 1-10 个中文或英文字母" }]}><Input autoFocus maxLength={10} autoComplete="username" /></Form.Item>
                <Form.Item name="password" label="密码" rules={[{ required: true, message: "请输入密码" }]}><Input.Password autoComplete="current-password" /></Form.Item>
                <Button block type="primary" htmlType="submit" loading={loading}>登录</Button>
            </Form>
            <p className="mt-4 text-center text-xs text-stone-400">账号由管理员统一创建；首次启动管理员账号为 root / root，首次登录需修改密码</p>
        </div>
    </div>;
}

import { App, Button, Modal, Progress } from "antd";
import { useEffect, useState } from "react";
import { formatBytes } from "@/lib/image-utils";
import { migrateLegacySnapshot, migrationMarker, readLegacySnapshot, type LegacySnapshot } from "@/services/legacy-migration";
import { useAuthStore } from "@/stores/use-auth-store";

export function LegacyMigrationPrompt() {
    const { message } = App.useApp(); const user = useAuthStore((state) => state.user); const [snapshot, setSnapshot] = useState<LegacySnapshot | null>(null); const [running, setRunning] = useState(false); const [progress, setProgress] = useState("");
    useEffect(() => { if (!user || user.mustChangePassword || localStorage.getItem(migrationMarker(user))) return; void readLegacySnapshot().then((value) => { if (value.projects.length || value.assets.length || value.imageLogs.length || value.videoLogs.length) setSnapshot(value); }); }, [user]);
    if (!user) return null;
    return <Modal open={Boolean(snapshot)} title="发现旧版浏览器数据" closable={!running} maskClosable={false} footer={null}>
        <p className="text-sm text-stone-600 dark:text-stone-300">可以将当前浏览器里的旧数据一次性迁移到账号「{user.username}」，迁移后其他浏览器登录即可访问。</p>
        {snapshot ? <div className="my-4 grid grid-cols-2 gap-2 text-sm"><div>画布：{snapshot.projects.length}</div><div>资产：{snapshot.assets.length}</div><div>生图记录：{snapshot.imageLogs.length}</div><div>视频记录：{snapshot.videoLogs.length}</div><div className="col-span-2">媒体：{snapshot.storageKeys.length} 个，约 {formatBytes(snapshot.bytes)}</div></div> : null}
        {running ? <><Progress percent={undefined} status="active" showInfo={false} /><div className="mt-2 text-xs text-stone-500">{progress}</div></> : <div className="flex justify-end gap-2"><Button onClick={() => { localStorage.setItem(migrationMarker(user), "skipped"); setSnapshot(null); }}>暂不迁移</Button><Button type="primary" onClick={async () => { if (!snapshot) return; setRunning(true); try { await migrateLegacySnapshot(snapshot, user, setProgress); message.success("旧数据迁移完成"); setSnapshot(null); window.location.reload(); } catch (error) { message.error(error instanceof Error ? error.message : "迁移失败"); } finally { setRunning(false); } }}>开始迁移</Button></div>}
    </Modal>;
}

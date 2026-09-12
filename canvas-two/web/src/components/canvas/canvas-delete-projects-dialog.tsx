import { App, Button, Modal } from "antd";

import { useAssetStore } from "@/stores/use-asset-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useCanvasUiStore } from "@/stores/canvas/use-canvas-ui-store";

export function CanvasDeleteProjectsDialog() {
    const { message } = App.useApp();
    const ids = useCanvasUiStore((state) => state.deleteProjectIds);
    const setDeleteIds = useCanvasUiStore((state) => state.setDeleteProjectIds);
    const removeSelectedIds = useCanvasUiStore((state) => state.removeSelectedProjectIds);
    const deleteProjects = useCanvasStore((state) => state.deleteProjects);
    const cleanupImages = useAssetStore((state) => state.cleanupImages);
    const confirm = async () => {
        try {
            await deleteProjects(ids);
            cleanupImages();
            removeSelectedIds(ids);
            setDeleteIds([]);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "删除画布失败");
        }
    };

    return (
        <Modal
            title="删除画布？"
            open={ids.length > 0}
            centered
            onCancel={() => setDeleteIds([])}
            footer={
                <>
                    <Button onClick={() => setDeleteIds([])}>取消</Button>
                    <Button danger type="primary" onClick={() => void confirm()}>
                        删除
                    </Button>
                </>
            }
        >
            <p className="text-sm text-stone-500">将删除 {ids.length} 个画布，里面的节点和连线也会一起移除。</p>
        </Modal>
    );
}

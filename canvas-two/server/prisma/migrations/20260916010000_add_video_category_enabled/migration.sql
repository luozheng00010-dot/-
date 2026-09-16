-- 自动剪辑 · 分类管理（P2 F6）：VideoCategory 加 enabled 软删标记。
-- 停用（enabled=false）后不进上传表单与拆句 prompt，已有素材/批次引用保留不动。

ALTER TABLE "video_categories" ADD COLUMN "enabled" BOOLEAN NOT NULL DEFAULT true;

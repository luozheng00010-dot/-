-- 媒体来源标记：知识库贴图标记为 kb，帖子删除/替换图片时可安全清理服务器文件
ALTER TABLE "media_files"
    ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'upload';

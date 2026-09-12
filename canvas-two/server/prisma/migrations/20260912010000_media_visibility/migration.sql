-- 媒体可见性：知识库等全员共享场景可把媒体标记为 public（登录成员可见）
ALTER TABLE "media_files"
    ADD COLUMN "visibility" TEXT NOT NULL DEFAULT 'private';

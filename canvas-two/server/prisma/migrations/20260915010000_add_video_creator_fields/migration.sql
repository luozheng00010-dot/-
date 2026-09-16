-- 自动剪辑：文案与导出任务补充创建人字段。
-- 普通字符串列、不建外键（与本模块其他 id 列一致，模块可整体删除不牵动共享表）；
-- 默认零值 uuid 兜底存量行。

ALTER TABLE "video_scripts" ADD COLUMN "created_by_id" TEXT NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000';

ALTER TABLE "video_export_tasks" ADD COLUMN "created_by_id" TEXT NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000';

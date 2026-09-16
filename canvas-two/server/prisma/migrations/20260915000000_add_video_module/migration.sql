-- 自动剪辑模块：分类 / 上传批次 / 素材 / 文案 / 时间线 / 导出任务 / 渠道设置
-- 注意：media_file_id / thumbnail_media_id / created_by_id / output_media_id 只存 id，
-- 不与 users / media_files 建外键（模块可整体删除，不牵动共享表）。

-- CreateTable
CREATE TABLE "video_categories" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "video_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "video_ingest_batches" (
    "id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "category_id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "total_count" INTEGER NOT NULL,
    "done_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'processing',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "video_ingest_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "video_materials" (
    "id" TEXT NOT NULL,
    "batch_id" TEXT,
    "media_file_id" TEXT NOT NULL,
    "thumbnail_media_id" TEXT,
    "sku" TEXT NOT NULL,
    "category_id" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "duration" DOUBLE PRECISION NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "tag_status" TEXT NOT NULL DEFAULT 'pending',
    "tag_error" TEXT,
    "description" TEXT,
    "shot_type" TEXT,
    "motion" TEXT,
    "product_visible" BOOLEAN,
    "review_status" TEXT NOT NULL DEFAULT 'none',
    "use_count" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "video_materials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "video_scripts" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "raw_text" TEXT NOT NULL,
    "sentences" JSONB,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "video_scripts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "video_timelines" (
    "id" TEXT NOT NULL,
    "script_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "items" JSONB NOT NULL,
    "gap_report" JSONB,
    "status" TEXT NOT NULL DEFAULT 'matched',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "video_timelines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "video_export_tasks" (
    "id" TEXT NOT NULL,
    "timeline_id" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "error" TEXT,
    "output_media_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "video_export_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "video_settings" (
    "id" TEXT NOT NULL,
    "chat_channel_id" TEXT,
    "chat_model" TEXT,
    "vision_channel_id" TEXT,
    "vision_model" TEXT,

    CONSTRAINT "video_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "video_categories_name_key" ON "video_categories"("name");
CREATE INDEX "video_materials_sku_category_id_status_idx" ON "video_materials"("sku", "category_id", "status");
CREATE INDEX "video_materials_tag_status_idx" ON "video_materials"("tag_status");
CREATE INDEX "video_export_tasks_status_created_at_idx" ON "video_export_tasks"("status", "created_at");

-- AddForeignKey
ALTER TABLE "video_ingest_batches" ADD CONSTRAINT "video_ingest_batches_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "video_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "video_materials" ADD CONSTRAINT "video_materials_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "video_ingest_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "video_materials" ADD CONSTRAINT "video_materials_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "video_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "video_timelines" ADD CONSTRAINT "video_timelines_script_id_fkey" FOREIGN KEY ("script_id") REFERENCES "video_scripts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "video_export_tasks" ADD CONSTRAINT "video_export_tasks_timeline_id_fkey" FOREIGN KEY ("timeline_id") REFERENCES "video_timelines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 分类种子：文胸 / 内裤 / 通用（isSystem=true），固定 UUID 便于环境间一致
INSERT INTO "video_categories" ("id", "name", "is_system", "sort_order", "created_at") VALUES
    ('00000000-0000-0000-0000-000000000101', '文胸', true, 1, CURRENT_TIMESTAMP),
    ('00000000-0000-0000-0000-000000000102', '内裤', true, 2, CURRENT_TIMESTAMP),
    ('00000000-0000-0000-0000-000000000103', '通用', true, 3, CURRENT_TIMESTAMP)
ON CONFLICT ("name") DO NOTHING;

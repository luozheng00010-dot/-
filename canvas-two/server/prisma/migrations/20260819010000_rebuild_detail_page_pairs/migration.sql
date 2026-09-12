-- 详情页复刻一对一重构：旧项目仅删除记录和关联，不删除 MediaFile。
-- 旧流程的排队/运行任务不再有可回写的 module 目标，先取消以避免重构后继续计费。
UPDATE "image_generation_tasks" AS task
SET
    "status" = 'cancelled',
    "error" = '详情页复刻流程已重构，旧任务已取消',
    "completed_count" = "total_count",
    "completed_at" = CURRENT_TIMESTAMP,
    "results" = COALESCE((
        SELECT jsonb_agg(jsonb_build_object('index', slot.index, 'status', 'failed', 'error', '详情页复刻流程已重构，旧任务已取消'))
        FROM generate_series(0, GREATEST(task."total_count", 1) - 1) AS slot(index)
    ), '[]'::jsonb)
WHERE task."status" IN ('queued', 'running')
  AND task."context" ->> 'origin' = 'detail-page';

DELETE FROM "detail_page_projects";

DROP TABLE IF EXISTS "detail_page_modules";
DROP TABLE IF EXISTS "detail_page_references";

ALTER TABLE "detail_page_projects"
    DROP COLUMN IF EXISTS "platform",
    DROP COLUMN IF EXISTS "instruction",
    DROP COLUMN IF EXISTS "include_brand",
    DROP COLUMN IF EXISTS "brand_override",
    DROP COLUMN IF EXISTS "include_text",
    DROP COLUMN IF EXISTS "text_override",
    DROP COLUMN IF EXISTS "include_packaging",
    DROP COLUMN IF EXISTS "product_snapshot",
    DROP COLUMN IF EXISTS "analysis",
    DROP COLUMN IF EXISTS "style_lock",
    DROP COLUMN IF EXISTS "page_count";

ALTER TABLE "detail_page_projects"
    DROP CONSTRAINT IF EXISTS "detail_page_projects_product_id_fkey";

ALTER TABLE "detail_page_projects"
    ADD CONSTRAINT "detail_page_projects_product_id_fkey"
    FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "detail_page_projects"
    ADD COLUMN "product_media_id" TEXT NOT NULL;

ALTER TABLE "detail_page_projects"
    ADD CONSTRAINT "detail_page_projects_product_media_id_fkey"
    FOREIGN KEY ("product_media_id") REFERENCES "media_files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "detail_page_pairs" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "reference_media_id" TEXT NOT NULL,
    "result_media_id" TEXT,
    "reference_width" INTEGER NOT NULL DEFAULT 0,
    "reference_height" INTEGER NOT NULL DEFAULT 0,
    "prompt" TEXT NOT NULL DEFAULT '',
    "resolved_prompt" TEXT,
    "active_task_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "error" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "detail_page_pairs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "detail_page_pairs_project_id_reference_media_id_key" ON "detail_page_pairs"("project_id", "reference_media_id");
CREATE UNIQUE INDEX "detail_page_pairs_active_task_id_key" ON "detail_page_pairs"("active_task_id");
CREATE INDEX "detail_page_pairs_project_id_sort_order_idx" ON "detail_page_pairs"("project_id", "sort_order");

ALTER TABLE "detail_page_pairs"
    ADD CONSTRAINT "detail_page_pairs_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "detail_page_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "detail_page_pairs"
    ADD CONSTRAINT "detail_page_pairs_reference_media_id_fkey"
    FOREIGN KEY ("reference_media_id") REFERENCES "media_files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "detail_page_pairs"
    ADD CONSTRAINT "detail_page_pairs_result_media_id_fkey"
    FOREIGN KEY ("result_media_id") REFERENCES "media_files"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "detail_page_pairs"
    ADD CONSTRAINT "detail_page_pairs_active_task_id_fkey"
    FOREIGN KEY ("active_task_id") REFERENCES "image_generation_tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

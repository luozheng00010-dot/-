ALTER TABLE "products" ADD COLUMN "material" TEXT NOT NULL DEFAULT '';

CREATE TABLE "detail_page_projects" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "updated_by_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "instruction" TEXT NOT NULL DEFAULT '',
    "include_brand" BOOLEAN NOT NULL DEFAULT false,
    "brand_override" TEXT NOT NULL DEFAULT '',
    "include_text" BOOLEAN NOT NULL DEFAULT false,
    "text_override" TEXT NOT NULL DEFAULT '',
    "include_packaging" BOOLEAN NOT NULL DEFAULT false,
    "product_snapshot" JSONB NOT NULL,
    "analysis" JSONB,
    "style_lock" JSONB,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "error" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "detail_page_projects_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "detail_page_references" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "media_id" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "detail_page_references_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "detail_page_modules" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "selling_points" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "cta" TEXT NOT NULL DEFAULT '',
    "prompt" TEXT NOT NULL DEFAULT '',
    "reference_media_id" TEXT,
    "result_media_id" TEXT,
    "active_task_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "error" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "detail_page_modules_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "detail_page_projects_owner_id_updated_at_idx" ON "detail_page_projects"("owner_id", "updated_at");
CREATE INDEX "detail_page_projects_product_id_idx" ON "detail_page_projects"("product_id");
CREATE UNIQUE INDEX "detail_page_references_project_id_media_id_key" ON "detail_page_references"("project_id", "media_id");
CREATE INDEX "detail_page_references_project_id_sort_order_idx" ON "detail_page_references"("project_id", "sort_order");
CREATE UNIQUE INDEX "detail_page_modules_active_task_id_key" ON "detail_page_modules"("active_task_id");
CREATE INDEX "detail_page_modules_project_id_sort_order_idx" ON "detail_page_modules"("project_id", "sort_order");

ALTER TABLE "detail_page_projects" ADD CONSTRAINT "detail_page_projects_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "detail_page_projects" ADD CONSTRAINT "detail_page_projects_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "detail_page_projects" ADD CONSTRAINT "detail_page_projects_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "detail_page_projects" ADD CONSTRAINT "detail_page_projects_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "detail_page_references" ADD CONSTRAINT "detail_page_references_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "detail_page_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "detail_page_references" ADD CONSTRAINT "detail_page_references_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "media_files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "detail_page_modules" ADD CONSTRAINT "detail_page_modules_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "detail_page_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "detail_page_modules" ADD CONSTRAINT "detail_page_modules_reference_media_id_fkey" FOREIGN KEY ("reference_media_id") REFERENCES "media_files"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "detail_page_modules" ADD CONSTRAINT "detail_page_modules_result_media_id_fkey" FOREIGN KEY ("result_media_id") REFERENCES "media_files"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "detail_page_modules" ADD CONSTRAINT "detail_page_modules_active_task_id_fkey" FOREIGN KEY ("active_task_id") REFERENCES "image_generation_tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

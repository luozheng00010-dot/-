CREATE TABLE "main_image_replication_projects" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "product_media_id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "updated_by_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "error" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "main_image_replication_projects_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "main_image_replication_projects_owner_id_updated_at_idx" ON "main_image_replication_projects"("owner_id", "updated_at");
CREATE INDEX "main_image_replication_projects_product_id_idx" ON "main_image_replication_projects"("product_id");
ALTER TABLE "main_image_replication_projects" ADD CONSTRAINT "main_image_replication_projects_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "main_image_replication_projects" ADD CONSTRAINT "main_image_replication_projects_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "main_image_replication_projects" ADD CONSTRAINT "main_image_replication_projects_product_media_id_fkey" FOREIGN KEY ("product_media_id") REFERENCES "media_files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "main_image_replication_projects" ADD CONSTRAINT "main_image_replication_projects_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "main_image_replication_projects" ADD CONSTRAINT "main_image_replication_projects_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "main_image_replication_pairs" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "reference_media_id" TEXT NOT NULL,
    "result_media_id" TEXT,
    "reference_width" INTEGER NOT NULL,
    "reference_height" INTEGER NOT NULL,
    "prompt" TEXT NOT NULL DEFAULT '',
    "resolved_prompt" TEXT,
    "active_task_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "error" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "main_image_replication_pairs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "main_image_replication_pairs_active_task_id_key" ON "main_image_replication_pairs"("active_task_id");
CREATE UNIQUE INDEX "main_image_replication_pairs_project_id_reference_media_id_key" ON "main_image_replication_pairs"("project_id", "reference_media_id");
CREATE INDEX "main_image_replication_pairs_project_id_sort_order_idx" ON "main_image_replication_pairs"("project_id", "sort_order");
ALTER TABLE "main_image_replication_pairs" ADD CONSTRAINT "main_image_replication_pairs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "main_image_replication_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "main_image_replication_pairs" ADD CONSTRAINT "main_image_replication_pairs_reference_media_id_fkey" FOREIGN KEY ("reference_media_id") REFERENCES "media_files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "main_image_replication_pairs" ADD CONSTRAINT "main_image_replication_pairs_result_media_id_fkey" FOREIGN KEY ("result_media_id") REFERENCES "media_files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "main_image_replication_variants" (
    "id" TEXT NOT NULL,
    "pair_id" TEXT NOT NULL,
    "media_id" TEXT,
    "source_media_id" TEXT,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "prompt" TEXT NOT NULL DEFAULT '',
    "resolved_prompt" TEXT,
    "active_task_id" TEXT,
    "error" TEXT,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT "main_image_replication_variants_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "main_image_replication_variants_active_task_id_key" ON "main_image_replication_variants"("active_task_id");
CREATE INDEX "main_image_replication_variants_pair_id_created_at_idx" ON "main_image_replication_variants"("pair_id", "created_at");
ALTER TABLE "main_image_replication_variants" ADD CONSTRAINT "main_image_replication_variants_pair_id_fkey" FOREIGN KEY ("pair_id") REFERENCES "main_image_replication_pairs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "main_image_replication_variants" ADD CONSTRAINT "main_image_replication_variants_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "media_files"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "main_image_replication_variants" ADD CONSTRAINT "main_image_replication_variants_source_media_id_fkey" FOREIGN KEY ("source_media_id") REFERENCES "media_files"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "main_image_replication_variants" ADD CONSTRAINT "main_image_replication_variants_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "main_image_replication_pairs" ADD CONSTRAINT "main_image_replication_pairs_active_task_id_fkey" FOREIGN KEY ("active_task_id") REFERENCES "image_generation_tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "main_image_replication_variants" ADD CONSTRAINT "main_image_replication_variants_active_task_id_fkey" FOREIGN KEY ("active_task_id") REFERENCES "image_generation_tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "main_image_replication_templates" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "updated_by_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "main_image_replication_templates_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "main_image_replication_templates_owner_id_name_key" ON "main_image_replication_templates"("owner_id", "name");
ALTER TABLE "main_image_replication_templates" ADD CONSTRAINT "main_image_replication_templates_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "main_image_replication_templates" ADD CONSTRAINT "main_image_replication_templates_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "main_image_replication_templates" ADD CONSTRAINT "main_image_replication_templates_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "main_image_replication_template_references" (
    "id" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "media_id" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "main_image_replication_template_references_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "main_image_replication_template_references_template_id_media_id_key" ON "main_image_replication_template_references"("template_id", "media_id");
CREATE UNIQUE INDEX "main_image_replication_template_references_template_id_sort_order_key" ON "main_image_replication_template_references"("template_id", "sort_order");
ALTER TABLE "main_image_replication_template_references" ADD CONSTRAINT "main_image_replication_template_references_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "main_image_replication_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "main_image_replication_template_references" ADD CONSTRAINT "main_image_replication_template_references_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "media_files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

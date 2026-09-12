CREATE TABLE "detail_page_pair_variants" (
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
    CONSTRAINT "detail_page_pair_variants_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "detail_page_pair_variants_active_task_id_key" ON "detail_page_pair_variants"("active_task_id");
CREATE INDEX "detail_page_pair_variants_pair_id_created_at_idx" ON "detail_page_pair_variants"("pair_id", "created_at");
CREATE INDEX "detail_page_pair_variants_media_id_idx" ON "detail_page_pair_variants"("media_id");
ALTER TABLE "detail_page_pair_variants" ADD CONSTRAINT "detail_page_pair_variants_pair_id_fkey" FOREIGN KEY ("pair_id") REFERENCES "detail_page_pairs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "detail_page_pair_variants" ADD CONSTRAINT "detail_page_pair_variants_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "media_files"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "detail_page_pair_variants" ADD CONSTRAINT "detail_page_pair_variants_source_media_id_fkey" FOREIGN KEY ("source_media_id") REFERENCES "media_files"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "detail_page_pair_variants" ADD CONSTRAINT "detail_page_pair_variants_active_task_id_fkey" FOREIGN KEY ("active_task_id") REFERENCES "image_generation_tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "detail_page_pair_variants" ADD CONSTRAINT "detail_page_pair_variants_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

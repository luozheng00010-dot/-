CREATE TABLE "detail_page_templates" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "updated_by_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "detail_page_templates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "detail_page_templates_owner_id_name_key" ON "detail_page_templates"("owner_id", "name");
CREATE INDEX "detail_page_templates_owner_id_updated_at_idx" ON "detail_page_templates"("owner_id", "updated_at");

ALTER TABLE "detail_page_templates" ADD CONSTRAINT "detail_page_templates_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "detail_page_templates" ADD CONSTRAINT "detail_page_templates_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "detail_page_templates" ADD CONSTRAINT "detail_page_templates_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "detail_page_template_references" (
    "id" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "media_id" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "detail_page_template_references_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "detail_page_template_references_template_id_media_id_key" ON "detail_page_template_references"("template_id", "media_id");
CREATE UNIQUE INDEX "detail_page_template_references_template_id_sort_order_key" ON "detail_page_template_references"("template_id", "sort_order");
CREATE INDEX "detail_page_template_references_media_id_idx" ON "detail_page_template_references"("media_id");

ALTER TABLE "detail_page_template_references" ADD CONSTRAINT "detail_page_template_references_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "detail_page_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "detail_page_template_references" ADD CONSTRAINT "detail_page_template_references_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "media_files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

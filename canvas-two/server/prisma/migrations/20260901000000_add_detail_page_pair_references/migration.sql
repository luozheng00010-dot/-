CREATE TABLE "detail_page_pair_references" (
    "id" TEXT NOT NULL,
    "pair_id" TEXT NOT NULL,
    "media_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'upload',
    "selected" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "detail_page_pair_references_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "detail_page_pair_references_pair_id_media_id_key" ON "detail_page_pair_references"("pair_id", "media_id");
CREATE INDEX "detail_page_pair_references_pair_id_sort_order_idx" ON "detail_page_pair_references"("pair_id", "sort_order");
CREATE INDEX "detail_page_pair_references_media_id_idx" ON "detail_page_pair_references"("media_id");
ALTER TABLE "detail_page_pair_references" ADD CONSTRAINT "detail_page_pair_references_pair_id_fkey" FOREIGN KEY ("pair_id") REFERENCES "detail_page_pairs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "detail_page_pair_references" ADD CONSTRAINT "detail_page_pair_references_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "media_files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

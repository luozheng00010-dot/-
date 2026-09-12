ALTER TABLE "detail_page_pairs"
    ADD COLUMN "generation_model" TEXT,
    ADD COLUMN "generation_channel_id" TEXT,
    ADD COLUMN "generation_resolution" TEXT NOT NULL DEFAULT '1k',
    ADD COLUMN "generation_aspect_ratio" TEXT NOT NULL DEFAULT 'original',
    ADD COLUMN "generation_quality" TEXT NOT NULL DEFAULT 'auto';

CREATE INDEX "detail_page_pairs_generation_channel_id_idx" ON "detail_page_pairs"("generation_channel_id");

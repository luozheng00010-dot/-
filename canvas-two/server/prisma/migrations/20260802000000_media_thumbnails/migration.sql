ALTER TABLE "media_files"
ADD COLUMN "thumbnail_object_key" TEXT,
ADD COLUMN "thumbnail_mime_type" TEXT,
ADD COLUMN "thumbnail_bytes" BIGINT;

CREATE UNIQUE INDEX "media_files_thumbnail_object_key_key" ON "media_files"("thumbnail_object_key");

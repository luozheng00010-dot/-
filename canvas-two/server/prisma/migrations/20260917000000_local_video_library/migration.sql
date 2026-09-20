CREATE TABLE "local_video_skus" (
    "id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "name_key" TEXT NOT NULL UNIQUE
);
CREATE TABLE "local_video_categories" (
    "id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "name_key" TEXT NOT NULL UNIQUE
);
CREATE TABLE "local_video_materials" (
    "id" TEXT PRIMARY KEY,
    "sku_id" TEXT REFERENCES "local_video_skus"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    "category_id" TEXT REFERENCES "local_video_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    "file_name" TEXT NOT NULL, "file_key" TEXT NOT NULL UNIQUE, "bytes" INTEGER NOT NULL,
    "uploaded_by_id" TEXT NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "deleted_at" TIMESTAMP(3),
    CONSTRAINT "local_video_active_assignment" CHECK ("deleted_at" IS NOT NULL OR ("sku_id" IS NOT NULL AND "category_id" IS NOT NULL))
);
CREATE INDEX "local_video_materials_selection_idx"
ON "local_video_materials"("sku_id", "category_id", "deleted_at", "created_at");

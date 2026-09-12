CREATE TABLE "products" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "updated_by_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "instruction" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "error" TEXT,
    "active_task_id" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "product_media" (
    "id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "media_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_media_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "products_active_task_id_key" ON "products"("active_task_id");
CREATE INDEX "products_owner_id_updated_at_idx" ON "products"("owner_id", "updated_at");
CREATE INDEX "products_owner_id_name_idx" ON "products"("owner_id", "name");
CREATE UNIQUE INDEX "product_media_product_id_media_id_role_key" ON "product_media"("product_id", "media_id", "role");
CREATE INDEX "product_media_product_id_role_sort_order_idx" ON "product_media"("product_id", "role", "sort_order");
CREATE INDEX "product_media_media_id_idx" ON "product_media"("media_id");

ALTER TABLE "products" ADD CONSTRAINT "products_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "products" ADD CONSTRAINT "products_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "products" ADD CONSTRAINT "products_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "products" ADD CONSTRAINT "products_active_task_id_fkey" FOREIGN KEY ("active_task_id") REFERENCES "image_generation_tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "product_media" ADD CONSTRAINT "product_media_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "product_media" ADD CONSTRAINT "product_media_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "media_files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

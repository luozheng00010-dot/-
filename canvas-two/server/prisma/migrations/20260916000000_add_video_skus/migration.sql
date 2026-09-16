-- 自动剪辑 · 货号管理：货号是一等数据，先建后用（上传素材 / 创建文案时必须已存在）。
-- 通用素材的 sku 是哨兵值 "通用"（D3），不参与货号管理，不入本表。

-- CreateTable
CREATE TABLE "video_skus" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "video_skus_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "video_skus_name_key" ON "video_skus"("name");

-- 存量数据种子：把 video_materials 中已有的非通用货号搬进来，保证"先建后用"校验不拦旧数据
INSERT INTO "video_skus" ("id", "name", "created_at")
SELECT gen_random_uuid()::text, sku, CURRENT_TIMESTAMP
FROM (SELECT DISTINCT sku FROM video_materials WHERE sku <> '通用') t
ON CONFLICT ("name") DO NOTHING;

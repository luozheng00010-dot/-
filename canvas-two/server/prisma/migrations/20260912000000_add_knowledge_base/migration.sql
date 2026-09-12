-- 公司知识库模块：pgvector 扩展 + 论坛/检索/对话数据表
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateTable
CREATE TABLE "kb_categories" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kb_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kb_posts" (
    "id" TEXT NOT NULL,
    "author_id" TEXT NOT NULL,
    "category_id" TEXT,
    "title" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'insight',
    "content" TEXT NOT NULL,
    "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'published',
    "official" BOOLEAN NOT NULL DEFAULT false,
    "view_count" INTEGER NOT NULL DEFAULT 0,
    "index_status" TEXT NOT NULL DEFAULT 'pending',
    "index_error" TEXT,
    "indexed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kb_posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kb_comments" (
    "id" TEXT NOT NULL,
    "post_id" TEXT NOT NULL,
    "author_id" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "parent_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kb_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kb_chunks" (
    "id" TEXT NOT NULL,
    "post_id" TEXT NOT NULL,
    "ord" INTEGER NOT NULL,
    "heading" TEXT,
    "content" TEXT NOT NULL,
    "embedding" vector,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kb_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kb_conversations" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kb_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kb_messages" (
    "id" TEXT NOT NULL,
    "conv_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "citations" JSONB,
    "feedback" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kb_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kb_settings" (
    "id" TEXT NOT NULL,
    "chat_channel_id" TEXT,
    "chat_model" TEXT,
    "embed_channel_id" TEXT,
    "embed_model" TEXT,
    "daily_limit_per_user" INTEGER NOT NULL DEFAULT 50,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kb_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "kb_posts_author_id_idx" ON "kb_posts"("author_id");
CREATE INDEX "kb_posts_category_id_idx" ON "kb_posts"("category_id");
CREATE INDEX "kb_posts_status_updated_at_idx" ON "kb_posts"("status", "updated_at");
CREATE INDEX "kb_comments_post_id_idx" ON "kb_comments"("post_id");
CREATE INDEX "kb_chunks_post_id_idx" ON "kb_chunks"("post_id");
CREATE INDEX "kb_conversations_user_id_updated_at_idx" ON "kb_conversations"("user_id", "updated_at");
CREATE INDEX "kb_messages_conv_id_idx" ON "kb_messages"("conv_id");

-- 注意：embedding 列不带固定维度（兼容不同 embedding 模型），
-- 无法在空表上预建 HNSW 索引（pgvector 报错 "column does not have dimensions"）。
-- 索引入库时由 kb 索引器在首批向量写入后惰性创建。

-- AddForeignKey
ALTER TABLE "kb_posts" ADD CONSTRAINT "kb_posts_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "kb_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "kb_comments" ADD CONSTRAINT "kb_comments_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "kb_posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "kb_chunks" ADD CONSTRAINT "kb_chunks_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "kb_posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "kb_messages" ADD CONSTRAINT "kb_messages_conv_id_fkey" FOREIGN KEY ("conv_id") REFERENCES "kb_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "username_key" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "must_change_password" BOOLEAN NOT NULL DEFAULT false,
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "member_permissions" (
    "id" TEXT NOT NULL,
    "grantee_id" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "member_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "canvas_projects" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "updated_by_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "legacy_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "canvas_projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workbench_generations" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "updated_by_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'success',
    "payload" JSONB NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "legacy_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workbench_generations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assets" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "updated_by_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "legacy_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_files" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "object_key" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "bytes" BIGINT NOT NULL,
    "legacy_storage_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "model_channels" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "base_url" TEXT NOT NULL,
    "api_format" TEXT NOT NULL,
    "api_key_encrypted" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "model_channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_models" (
    "id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "capability" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "channel_models_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key_key" ON "users"("username_key");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "member_permissions_grantee_id_target_id_key" ON "member_permissions"("grantee_id", "target_id");

-- CreateIndex
CREATE INDEX "canvas_projects_owner_id_updated_at_idx" ON "canvas_projects"("owner_id", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "canvas_projects_owner_id_legacy_id_key" ON "canvas_projects"("owner_id", "legacy_id");

-- CreateIndex
CREATE INDEX "workbench_generations_owner_id_kind_created_at_idx" ON "workbench_generations"("owner_id", "kind", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "workbench_generations_owner_id_kind_legacy_id_key" ON "workbench_generations"("owner_id", "kind", "legacy_id");

-- CreateIndex
CREATE INDEX "assets_owner_id_updated_at_idx" ON "assets"("owner_id", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "assets_owner_id_legacy_id_key" ON "assets"("owner_id", "legacy_id");

-- CreateIndex
CREATE UNIQUE INDEX "media_files_object_key_key" ON "media_files"("object_key");

-- CreateIndex
CREATE INDEX "media_files_owner_id_created_at_idx" ON "media_files"("owner_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "media_files_owner_id_legacy_storage_key_key" ON "media_files"("owner_id", "legacy_storage_key");

-- CreateIndex
CREATE UNIQUE INDEX "channel_models_channel_id_name_key" ON "channel_models"("channel_id", "name");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_permissions" ADD CONSTRAINT "member_permissions_grantee_id_fkey" FOREIGN KEY ("grantee_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_permissions" ADD CONSTRAINT "member_permissions_target_id_fkey" FOREIGN KEY ("target_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "canvas_projects" ADD CONSTRAINT "canvas_projects_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "canvas_projects" ADD CONSTRAINT "canvas_projects_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "canvas_projects" ADD CONSTRAINT "canvas_projects_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workbench_generations" ADD CONSTRAINT "workbench_generations_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workbench_generations" ADD CONSTRAINT "workbench_generations_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workbench_generations" ADD CONSTRAINT "workbench_generations_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_files" ADD CONSTRAINT "media_files_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_files" ADD CONSTRAINT "media_files_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_models" ADD CONSTRAINT "channel_models_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "model_channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "image_generation_tasks" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "client_request_id" TEXT NOT NULL,
    "retry_of_id" TEXT,
    "operation" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "request_prompt" TEXT NOT NULL,
    "parameters" JSONB NOT NULL,
    "references" JSONB NOT NULL,
    "mask_media_id" TEXT,
    "context" JSONB,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "completed_count" INTEGER NOT NULL DEFAULT 0,
    "total_count" INTEGER NOT NULL DEFAULT 1,
    "results" JSONB NOT NULL,
    "error" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMP(3),
    "heartbeat_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "image_generation_tasks_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "image_generation_tasks_owner_id_client_request_id_key" ON "image_generation_tasks"("owner_id", "client_request_id");
CREATE INDEX "image_generation_tasks_status_created_at_idx" ON "image_generation_tasks"("status", "created_at");
CREATE INDEX "image_generation_tasks_owner_id_created_at_idx" ON "image_generation_tasks"("owner_id", "created_at");
ALTER TABLE "image_generation_tasks" ADD CONSTRAINT "image_generation_tasks_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "image_generation_tasks" ADD CONSTRAINT "image_generation_tasks_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "image_generation_tasks" ADD CONSTRAINT "image_generation_tasks_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "model_channels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

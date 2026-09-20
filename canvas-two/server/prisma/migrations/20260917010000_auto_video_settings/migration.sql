CREATE TABLE "auto_video_settings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "channel_id" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "auto_video_settings_pkey" PRIMARY KEY ("id")
);

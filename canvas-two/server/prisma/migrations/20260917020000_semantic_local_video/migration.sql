CREATE EXTENSION IF NOT EXISTS vector;
ALTER TABLE auto_video_settings ADD COLUMN vision_channel_id TEXT, ADD COLUMN vision_model TEXT,
 ADD COLUMN embed_channel_id TEXT, ADD COLUMN embed_model TEXT, ADD COLUMN vision_verified TEXT;
ALTER TABLE local_video_materials
 ADD COLUMN duration DOUBLE PRECISION, ADD COLUMN width INTEGER, ADD COLUMN height INTEGER,
 ADD COLUMN fps DOUBLE PRECISION, ADD COLUMN thumbnail TEXT, ADD COLUMN disabled BOOLEAN NOT NULL DEFAULT false,
 ADD COLUMN annotation JSONB, ADD COLUMN proposed_annotation JSONB, ADD COLUMN annotation_source TEXT,
 ADD COLUMN revision INTEGER NOT NULL DEFAULT 0, ADD COLUMN analysis_status TEXT NOT NULL DEFAULT 'pending',
 ADD COLUMN analysis_error TEXT, ADD COLUMN embedding vector, ADD COLUMN embedding_key TEXT,
 ADD COLUMN embedding_dimension INTEGER, ADD COLUMN indexed_revision INTEGER;
CREATE TABLE auto_video_plans (
 id TEXT PRIMARY KEY, created_by_id TEXT NOT NULL, request_id TEXT NOT NULL UNIQUE,
 revision INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'queued', input JSONB NOT NULL,
 document JSONB, error TEXT, created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TIMESTAMP(3) NOT NULL
);
CREATE TABLE auto_video_jobs (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL, target_id TEXT NOT NULL, dedupe_key TEXT NOT NULL UNIQUE,
 status TEXT NOT NULL DEFAULT 'queued', payload JSONB NOT NULL, result JSONB,
 attempts INTEGER NOT NULL DEFAULT 0, lease_token TEXT, lease_until TIMESTAMP(3),
 available_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, error TEXT,
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP(3) NOT NULL
);
CREATE INDEX auto_video_jobs_kind_status_available_at_idx ON auto_video_jobs(kind,status,available_at);
CREATE INDEX auto_video_jobs_target_id_created_at_idx ON auto_video_jobs(target_id,created_at);

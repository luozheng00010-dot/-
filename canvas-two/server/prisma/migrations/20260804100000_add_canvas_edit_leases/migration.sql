-- CreateTable
CREATE TABLE "canvas_edit_leases" (
    "id" TEXT NOT NULL,
    "canvas_id" TEXT NOT NULL,
    "holder_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "acquired_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "heartbeat_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "canvas_edit_leases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "canvas_edit_leases_canvas_id_key" ON "canvas_edit_leases"("canvas_id");
CREATE INDEX "canvas_edit_leases_holder_id_idx" ON "canvas_edit_leases"("holder_id");
CREATE INDEX "canvas_edit_leases_expires_at_idx" ON "canvas_edit_leases"("expires_at");

-- AddForeignKey
ALTER TABLE "canvas_edit_leases" ADD CONSTRAINT "canvas_edit_leases_canvas_id_fkey" FOREIGN KEY ("canvas_id") REFERENCES "canvas_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "canvas_edit_leases" ADD CONSTRAINT "canvas_edit_leases_holder_id_fkey" FOREIGN KEY ("holder_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

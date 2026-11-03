-- Specimen receipt, label printing and rejection (W-2, W-3). Expand-only (06 §3.3).
ALTER TABLE "specimen" ADD COLUMN "received_at" TIMESTAMPTZ,
ADD COLUMN "received_by" TEXT,
ADD COLUMN "label_prints" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "rejection_reason" TEXT;

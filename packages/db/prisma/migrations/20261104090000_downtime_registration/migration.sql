-- Downtime registration and reconciliation (06 §5.2). Expand-only.
ALTER TABLE "patient"
  ADD COLUMN "provisional" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "merged_into_id" UUID;

ALTER TABLE "lab_order"
  ADD COLUMN "source" TEXT NOT NULL DEFAULT 'HMIS',
  ADD COLUMN "reconciled_to_id" UUID,
  ADD COLUMN "reconciled_at" TIMESTAMPTZ,
  ADD COLUMN "reconciled_by" TEXT;

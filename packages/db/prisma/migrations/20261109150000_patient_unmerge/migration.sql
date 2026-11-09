-- Undoing a patient merge (A-35, A-39). Expand-only. A confirmed merge recorded in
-- error, or reversed by medical records in the HMIS, is undone by two people like
-- the merge itself: one proposes with a reference and a reason, a different person
-- confirms. The merge row stays, marked UNDONE, so a later merge of the same MRN
-- can be recorded.
ALTER TABLE "patient_merge"
  ADD COLUMN "undo_reference" TEXT,
  ADD COLUMN "undo_reason" TEXT,
  ADD COLUMN "undo_proposed_by" TEXT,
  ADD COLUMN "undo_proposed_at" TIMESTAMPTZ,
  ADD COLUMN "undone_by" TEXT,
  ADD COLUMN "undone_at" TIMESTAMPTZ;
ALTER TABLE "patient_merge" DROP CONSTRAINT "patient_merge_status_chk";
ALTER TABLE "patient_merge" ADD CONSTRAINT "patient_merge_status_chk" CHECK ("status" IN ('PROPOSED', 'CONFIRMED', 'WITHDRAWN', 'UNDONE'));
ALTER TABLE "patient_merge" ADD CONSTRAINT "patient_merge_undo_chk" CHECK (
  ("undo_proposed_by" IS NULL OR "status" IN ('CONFIRMED', 'UNDONE'))
  AND ("status" <> 'UNDONE' OR ("undo_proposed_by" IS NOT NULL AND "undone_by" IS NOT NULL AND "undone_at" IS NOT NULL AND "undone_by" <> "undo_proposed_by"))
);

-- Linking an unmatched result to a specimen needs a second person (10 §2):
-- the first person's proposal is held on the row until someone else confirms it.
-- Expand-only.
ALTER TABLE "unmatched_result"
  ADD COLUMN "proposed_test_id" UUID,
  ADD COLUMN "proposed_by" TEXT,
  ADD COLUMN "proposed_at" TIMESTAMPTZ,
  ADD COLUMN "proposal_reason" TEXT,
  ADD COLUMN "linked_result_id" UUID;

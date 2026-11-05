-- A test added to an order by the lab from an unmatched result (A-34, W-7). Expand-only.
-- The clinician asked for a test on a specimen already in the lab (an add-on), and the
-- instrument ran it before the HMIS had the order line. Two people add it; its result is
-- held from the HMIS until the clinician's order line arrives and is matched to it.
ALTER TABLE "ordered_test" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'HMIS';
ALTER TABLE "ordered_test" ADD COLUMN "requested_by" TEXT;
ALTER TABLE "ordered_test" ADD COLUMN "added_by" TEXT;
ALTER TABLE "ordered_test" ADD COLUMN "added_confirmed_by" TEXT;
ALTER TABLE "ordered_test" ADD COLUMN "added_reason" TEXT;
ALTER TABLE "ordered_test" ADD COLUMN "added_at" TIMESTAMPTZ;
-- The HMIS order line's test its specimen and result moved to.
ALTER TABLE "ordered_test" ADD COLUMN "matched_to_id" UUID;
ALTER TABLE "ordered_test" ADD COLUMN "matched_by" TEXT;
ALTER TABLE "ordered_test" ADD COLUMN "matched_at" TIMESTAMPTZ;
ALTER TABLE "ordered_test" ADD CONSTRAINT "ordered_test_source_chk" CHECK ("source" IN ('HMIS', 'LAB_ADDED'));
ALTER TABLE "ordered_test" ADD CONSTRAINT "ordered_test_added_chk" CHECK (
  "source" = 'HMIS' OR ("requested_by" IS NOT NULL AND "added_by" IS NOT NULL AND "added_confirmed_by" IS NOT NULL AND "added_reason" IS NOT NULL AND "added_at" IS NOT NULL)
);
-- Two people: the one who proposes the added test does not confirm it.
ALTER TABLE "ordered_test" ADD CONSTRAINT "ordered_test_added_two_person_chk" CHECK ("added_confirmed_by" IS NULL OR "added_confirmed_by" <> "added_by");
ALTER TABLE "ordered_test" ADD CONSTRAINT "ordered_test_matched_to_id_fkey" FOREIGN KEY ("matched_to_id") REFERENCES "ordered_test"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- An unmatched result's proposal is a link to an ordered test (as before) or an added test on a specimen.
ALTER TABLE "unmatched_result" ADD COLUMN "proposed_action" TEXT;
ALTER TABLE "unmatched_result" ADD COLUMN "proposed_specimen_id" UUID;
ALTER TABLE "unmatched_result" ADD COLUMN "proposed_requested_by" TEXT;
UPDATE "unmatched_result" SET "proposed_action" = 'LINK' WHERE "proposed_by" IS NOT NULL;
ALTER TABLE "unmatched_result" ADD CONSTRAINT "unmatched_result_action_chk" CHECK (
  ("proposed_by" IS NULL AND "proposed_action" IS NULL)
  OR ("proposed_action" = 'LINK' AND "proposed_test_id" IS NOT NULL)
  OR ("proposed_action" = 'ADD_TEST' AND "proposed_specimen_id" IS NOT NULL AND "proposed_requested_by" IS NOT NULL)
);

-- R-4s within-run Westgard rule (A-38). Expand-only: a nullable run window
-- on the QC range; R-4s is only kept on a range that has one.
ALTER TABLE "qc_range" ADD COLUMN "run_minutes" INTEGER;
ALTER TABLE "qc_range" ADD CONSTRAINT "qc_range_run_minutes_chk" CHECK ("run_minutes" IS NULL OR "run_minutes" BETWEEN 1 AND 240);
ALTER TABLE "qc_range" ADD CONSTRAINT "qc_range_r4s_run_chk" CHECK (NOT ('R-4s' = ANY ("westgard_rules")) OR "run_minutes" IS NOT NULL);
ALTER TABLE "qc_range" DROP CONSTRAINT "qc_range_westgard_rules_chk";
ALTER TABLE "qc_range" ADD CONSTRAINT "qc_range_westgard_rules_chk" CHECK ("westgard_rules" <@ ARRAY['1-2s', '1-3s', '2-2s', 'R-4s', '4-1s', '10x']::TEXT[]);

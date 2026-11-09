-- 2-2s within the run, across controls (A-40). Expand-only: the new rule is
-- allowed in westgard_rules, and like R-4s it is only kept with a run window.
ALTER TABLE "qc_range" ADD CONSTRAINT "qc_range_22s_run_chk" CHECK (NOT ('2-2s-run' = ANY ("westgard_rules")) OR "run_minutes" IS NOT NULL);
ALTER TABLE "qc_range" DROP CONSTRAINT "qc_range_westgard_rules_chk";
ALTER TABLE "qc_range" ADD CONSTRAINT "qc_range_westgard_rules_chk" CHECK ("westgard_rules" <@ ARRAY['1-2s', '1-3s', '2-2s', '2-2s-run', 'R-4s', '4-1s', '10x']::TEXT[]);

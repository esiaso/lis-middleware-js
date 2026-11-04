-- Westgard rules on QC ranges (08 §12, A-23). Expand-only. No means, SDs or rules are shipped.
ALTER TABLE "qc_range" ADD COLUMN "target_mean" TEXT;
ALTER TABLE "qc_range" ADD COLUMN "target_sd" TEXT;
ALTER TABLE "qc_range" ADD COLUMN "westgard_rules" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "qc_range" ADD CONSTRAINT "qc_range_target_chk" CHECK (
  ("target_mean" IS NULL AND "target_sd" IS NULL AND cardinality("westgard_rules") = 0)
  OR ("target_mean" ~ '^[+-]?\d+(\.\d+)?$' AND "target_sd" ~ '^\d+(\.\d+)?$' AND "target_sd"::numeric > 0)
);
ALTER TABLE "qc_range" ADD CONSTRAINT "qc_range_westgard_rules_chk" CHECK ("westgard_rules" <@ ARRAY['1-2s', '1-3s', '2-2s', '4-1s', '10x']::TEXT[]);

ALTER TABLE "qc_evaluation" ADD COLUMN "z_score" DOUBLE PRECISION;
ALTER TABLE "qc_evaluation" ADD COLUMN "westgard_reject" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "qc_evaluation" ADD COLUMN "westgard_warn" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
-- Widened to allow RULE_VIOLATION; every existing row still passes.
ALTER TABLE "qc_evaluation" DROP CONSTRAINT "qc_evaluation_outcome_chk";
ALTER TABLE "qc_evaluation" ADD CONSTRAINT "qc_evaluation_outcome_chk" CHECK ("outcome" IN ('IN_RANGE', 'OUT_OF_RANGE', 'RULE_VIOLATION', 'UNITS_DIFFER', 'NO_RANGE', 'NOT_NUMERIC'));
-- The series for one control: its earlier results, newest first.
CREATE INDEX "qc_evaluation_range_id_at_idx" ON "qc_evaluation"("range_id", "at");

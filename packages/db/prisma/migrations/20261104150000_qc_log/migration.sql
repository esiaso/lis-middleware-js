-- QC ranges and the check of each QC result (08 §12, A-21). Expand-only. No ranges are shipped.
ALTER TABLE "autoverify_rule" ADD COLUMN "qc_within_hours" INTEGER;
ALTER TABLE "autoverify_rule" ADD CONSTRAINT "autoverify_rule_qc_hours_chk" CHECK ("qc_within_hours" IS NULL OR "qc_within_hours" BETWEEN 1 AND 168);

CREATE TABLE "qc_range" (
    "id" UUID NOT NULL,
    "instrument_id" TEXT NOT NULL,
    "local_test_code" TEXT NOT NULL,
    "control_lot" TEXT,
    "control_name" TEXT,
    "low" TEXT NOT NULL,
    "high" TEXT NOT NULL,
    "units" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retired_by" TEXT,
    "retired_at" TIMESTAMPTZ,
    "retire_reason" TEXT,
    CONSTRAINT "qc_range_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "qc_range_control_chk" CHECK ("control_lot" IS NOT NULL OR "control_name" IS NOT NULL),
    CONSTRAINT "qc_range_decimal_chk" CHECK ("low" ~ '^[+-]?\d+(\.\d+)?$' AND "high" ~ '^[+-]?\d+(\.\d+)?$'),
    CONSTRAINT "qc_range_order_chk" CHECK ("low"::numeric <= "high"::numeric),
    CONSTRAINT "qc_range_retired_chk" CHECK ("active" OR ("retired_by" IS NOT NULL AND "retired_at" IS NOT NULL))
);
CREATE INDEX "qc_range_instrument_id_local_test_code_active_idx" ON "qc_range"("instrument_id", "local_test_code", "active");
-- One active range per instrument, test and control.
CREATE UNIQUE INDEX "qc_range_one_active" ON "qc_range"("instrument_id", "local_test_code", COALESCE("control_lot", ''), COALESCE("control_name", '')) WHERE "active";
ALTER TABLE "qc_range" ADD CONSTRAINT "qc_range_instrument_id_fkey" FOREIGN KEY ("instrument_id") REFERENCES "instrument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "qc_evaluation" (
    "id" UUID NOT NULL,
    "observation_id" UUID NOT NULL,
    "instrument_id" TEXT NOT NULL,
    "local_test_code" TEXT,
    "control_lot" TEXT,
    "control_name" TEXT,
    "control_level" TEXT,
    "value" JSONB NOT NULL,
    "units" TEXT,
    "range_id" UUID,
    "outcome" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "qc_evaluation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "qc_evaluation_outcome_chk" CHECK ("outcome" IN ('IN_RANGE', 'OUT_OF_RANGE', 'UNITS_DIFFER', 'NO_RANGE', 'NOT_NUMERIC'))
);
CREATE UNIQUE INDEX "qc_evaluation_observation_id_key" ON "qc_evaluation"("observation_id");
CREATE INDEX "qc_evaluation_instrument_id_local_test_code_at_idx" ON "qc_evaluation"("instrument_id", "local_test_code", "at");
CREATE INDEX "qc_evaluation_at_idx" ON "qc_evaluation"("at");
ALTER TABLE "qc_evaluation" ADD CONSTRAINT "qc_evaluation_observation_id_fkey" FOREIGN KEY ("observation_id") REFERENCES "observation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TRIGGER qc_evaluation_append_only BEFORE UPDATE OR DELETE ON qc_evaluation FOR EACH ROW EXECUTE FUNCTION append_only();

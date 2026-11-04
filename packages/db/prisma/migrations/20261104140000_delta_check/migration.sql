-- Delta check rules and the flag on each version (08 §12, A-20). Expand-only. No rules are shipped.
ALTER TABLE "result_version"
  ADD COLUMN "delta_flag" TEXT,
  ADD COLUMN "delta_rule_id" UUID,
  ADD COLUMN "delta_previous_result_id" UUID,
  ADD COLUMN "delta_detail" TEXT;
ALTER TABLE "result_version" ADD CONSTRAINT "result_version_delta_flag_chk" CHECK ("delta_flag" IS NULL OR "delta_flag" IN ('EXCEEDED', 'UNITS_DIFFER'));

CREATE TABLE "delta_rule" (
    "id" UUID NOT NULL,
    "local_test_code" TEXT NOT NULL,
    "max_abs" TEXT,
    "max_percent" TEXT,
    "window_days" INTEGER NOT NULL,
    "units" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retired_by" TEXT,
    "retired_at" TIMESTAMPTZ,
    "retire_reason" TEXT,
    CONSTRAINT "delta_rule_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "delta_rule_bound_chk" CHECK ("max_abs" IS NOT NULL OR "max_percent" IS NOT NULL),
    CONSTRAINT "delta_rule_decimal_chk" CHECK (("max_abs" IS NULL OR "max_abs" ~ '^\d+(\.\d+)?$') AND ("max_percent" IS NULL OR "max_percent" ~ '^\d+(\.\d+)?$')),
    CONSTRAINT "delta_rule_window_chk" CHECK ("window_days" BETWEEN 1 AND 3650),
    CONSTRAINT "delta_rule_retired_chk" CHECK ("active" OR ("retired_by" IS NOT NULL AND "retired_at" IS NOT NULL))
);
CREATE INDEX "delta_rule_local_test_code_active_idx" ON "delta_rule"("local_test_code", "active");
-- One active rule per test, so there is never a question of which one applied.
CREATE UNIQUE INDEX "delta_rule_one_active" ON "delta_rule"("local_test_code") WHERE "active";

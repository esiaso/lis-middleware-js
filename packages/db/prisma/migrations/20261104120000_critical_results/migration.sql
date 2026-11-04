-- Critical result limits, flags and call records (08 §12). Expand-only.
ALTER TABLE "result_version"
  ADD COLUMN "critical_flag" TEXT,
  ADD COLUMN "critical_limit_id" UUID,
  ADD COLUMN "critical_detail" TEXT;
ALTER TABLE "result_version" ADD CONSTRAINT "result_version_critical_flag_chk" CHECK ("critical_flag" IS NULL OR "critical_flag" IN ('LOW', 'HIGH', 'UNITS_DIFFER'));

CREATE TABLE "critical_limit" (
    "id" UUID NOT NULL,
    "local_test_code" TEXT NOT NULL,
    "sex" TEXT,
    "age_min_days" INTEGER,
    "age_max_days" INTEGER,
    "low" TEXT,
    "high" TEXT,
    "units" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retired_by" TEXT,
    "retired_at" TIMESTAMPTZ,
    "retire_reason" TEXT,
    CONSTRAINT "critical_limit_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "critical_limit_sex_chk" CHECK ("sex" IS NULL OR "sex" IN ('F', 'M')),
    CONSTRAINT "critical_limit_bound_chk" CHECK ("low" IS NOT NULL OR "high" IS NOT NULL),
    CONSTRAINT "critical_limit_decimal_chk" CHECK (("low" IS NULL OR "low" ~ '^[+-]?\d+(\.\d+)?$') AND ("high" IS NULL OR "high" ~ '^[+-]?\d+(\.\d+)?$')),
    CONSTRAINT "critical_limit_retired_chk" CHECK ("active" OR ("retired_by" IS NOT NULL AND "retired_at" IS NOT NULL))
);
CREATE INDEX "critical_limit_local_test_code_active_idx" ON "critical_limit"("local_test_code", "active");

CREATE TABLE "critical_call" (
    "id" UUID NOT NULL,
    "result_id" UUID NOT NULL,
    "version_no" INTEGER NOT NULL,
    "notified" TEXT NOT NULL,
    "notified_role" TEXT NOT NULL,
    "called_at" TIMESTAMPTZ NOT NULL,
    "read_back" BOOLEAN NOT NULL,
    "note" TEXT,
    "recorded_by" TEXT NOT NULL,
    "recorded_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "critical_call_pkey" PRIMARY KEY ("id"),
    -- A call without read-back is not a completed communication (08 §12).
    CONSTRAINT "critical_call_read_back_chk" CHECK ("read_back")
);
CREATE INDEX "critical_call_result_id_version_no_idx" ON "critical_call"("result_id", "version_no");
ALTER TABLE "critical_call" ADD CONSTRAINT "critical_call_result_id_fkey" FOREIGN KEY ("result_id") REFERENCES "result"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TRIGGER critical_call_append_only BEFORE UPDATE OR DELETE ON critical_call FOR EACH ROW EXECUTE FUNCTION append_only();

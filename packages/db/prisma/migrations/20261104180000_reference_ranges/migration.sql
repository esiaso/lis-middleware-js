-- Reference ranges entered by the lab (01 A-25). Expand-only. None are shipped.
CREATE TABLE "reference_range" (
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
    CONSTRAINT "reference_range_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "reference_range_sex_chk" CHECK ("sex" IS NULL OR "sex" IN ('F', 'M')),
    CONSTRAINT "reference_range_bound_chk" CHECK ("low" IS NOT NULL OR "high" IS NOT NULL),
    CONSTRAINT "reference_range_decimal_chk" CHECK (("low" IS NULL OR "low" ~ '^[+-]?\d+(\.\d+)?$') AND ("high" IS NULL OR "high" ~ '^[+-]?\d+(\.\d+)?$')),
    CONSTRAINT "reference_range_order_chk" CHECK ("low" IS NULL OR "high" IS NULL OR "low"::numeric <= "high"::numeric),
    CONSTRAINT "reference_range_age_chk" CHECK ("age_min_days" IS NULL OR "age_max_days" IS NULL OR "age_min_days" < "age_max_days"),
    CONSTRAINT "reference_range_retired_chk" CHECK ("active" OR ("retired_by" IS NOT NULL AND "retired_at" IS NOT NULL))
);
CREATE INDEX "reference_range_local_test_code_active_idx" ON "reference_range"("local_test_code", "active");
-- One active range per test, sex and age band.
CREATE UNIQUE INDEX "reference_range_one_active" ON "reference_range"("local_test_code", COALESCE("sex", ''), COALESCE("age_min_days", -1), COALESCE("age_max_days", -1)) WHERE "active";

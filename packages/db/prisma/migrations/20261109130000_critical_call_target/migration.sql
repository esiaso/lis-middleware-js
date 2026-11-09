-- How soon a critical result must be phoned (A-37). Expand-only.
-- A null test is the lab-wide target; at most one active target per test,
-- and one lab-wide. Never edited: a change retires the old target.
CREATE TABLE "critical_call_target" (
    "id" UUID NOT NULL,
    "local_test_code" TEXT,
    "minutes" INTEGER NOT NULL,
    "reference" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retired_by" TEXT,
    "retired_at" TIMESTAMPTZ,
    "retire_reason" TEXT,
    CONSTRAINT "critical_call_target_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "critical_call_target_minutes_chk" CHECK ("minutes" BETWEEN 1 AND 1440),
    CONSTRAINT "critical_call_target_retired_chk" CHECK ("active" OR ("retired_by" IS NOT NULL AND "retired_at" IS NOT NULL))
);
CREATE INDEX "critical_call_target_active_idx" ON "critical_call_target"("active");
CREATE UNIQUE INDEX "critical_call_target_one_active" ON "critical_call_target"(COALESCE("local_test_code", '')) WHERE "active";

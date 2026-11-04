-- Turnaround targets (A-22). Expand-only. No targets are shipped.
CREATE TABLE "tat_target" (
    "id" UUID NOT NULL,
    "local_test_code" TEXT,
    "priority" TEXT,
    "minutes" INTEGER NOT NULL,
    "reference" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retired_by" TEXT,
    "retired_at" TIMESTAMPTZ,
    "retire_reason" TEXT,
    CONSTRAINT "tat_target_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "tat_target_priority_chk" CHECK ("priority" IS NULL OR "priority" IN ('routine', 'urgent', 'stat')),
    CONSTRAINT "tat_target_minutes_chk" CHECK ("minutes" BETWEEN 1 AND 43200),
    CONSTRAINT "tat_target_retired_chk" CHECK ("active" OR ("retired_by" IS NOT NULL AND "retired_at" IS NOT NULL))
);
CREATE INDEX "tat_target_active_idx" ON "tat_target"("active");
-- One active target per test and priority (null meaning "every").
CREATE UNIQUE INDEX "tat_target_one_active" ON "tat_target"(COALESCE("local_test_code", ''), COALESCE("priority", '')) WHERE "active";

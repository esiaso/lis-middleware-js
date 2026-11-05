-- The lab's own test catalogue (design: "Test catalogue and LOINC"). Expand-only.
-- Each change is a new version; a second person makes it active. None are shipped.
CREATE TABLE "test_catalogue" (
    "id" UUID NOT NULL,
    "local_code" TEXT NOT NULL,
    "version_no" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "name" TEXT NOT NULL,
    "section" TEXT NOT NULL,
    "loinc_code" TEXT,
    "loinc_display" TEXT,
    "sha_code" TEXT,
    "specimen_type" TEXT,
    "performed_by" TEXT NOT NULL,
    "result_type" TEXT NOT NULL,
    "answers" JSONB NOT NULL DEFAULT '[]',
    "unit" TEXT,
    "decimals" INTEGER,
    "change_reason" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approved_by" TEXT,
    "approved_at" TIMESTAMPTZ,
    "retired_by" TEXT,
    "retired_at" TIMESTAMPTZ,
    "retire_reason" TEXT,
    CONSTRAINT "test_catalogue_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "test_catalogue_code_chk" CHECK ("local_code" ~ '^[A-Z0-9][A-Z0-9._-]{0,19}$'),
    CONSTRAINT "test_catalogue_status_chk" CHECK ("status" IN ('DRAFT', 'ACTIVE', 'RETIRED', 'DISCARDED')),
    CONSTRAINT "test_catalogue_performed_chk" CHECK ("performed_by" IN ('INSTRUMENT', 'MANUAL')),
    CONSTRAINT "test_catalogue_type_chk" CHECK ("result_type" IN ('NUMERIC', 'ORDINAL', 'NOMINAL', 'TEXT')),
    CONSTRAINT "test_catalogue_loinc_chk" CHECK ("loinc_code" IS NULL OR "loinc_code" ~ '^[0-9]{1,7}-[0-9]$'),
    CONSTRAINT "test_catalogue_decimals_chk" CHECK ("decimals" IS NULL OR "decimals" BETWEEN 0 AND 6),
    -- Nobody approves their own change.
    CONSTRAINT "test_catalogue_two_person_chk" CHECK ("approved_by" IS NULL OR "approved_by" <> "created_by"),
    CONSTRAINT "test_catalogue_approved_chk" CHECK ("status" = 'DRAFT' OR "status" = 'DISCARDED' OR ("approved_by" IS NOT NULL AND "approved_at" IS NOT NULL)),
    CONSTRAINT "test_catalogue_retired_chk" CHECK ("status" NOT IN ('RETIRED', 'DISCARDED') OR ("retired_by" IS NOT NULL AND "retired_at" IS NOT NULL))
);
CREATE UNIQUE INDEX "test_catalogue_code_version" ON "test_catalogue"("local_code", "version_no");
-- One active version and at most one draft per test.
CREATE UNIQUE INDEX "test_catalogue_one_active" ON "test_catalogue"("local_code") WHERE "status" = 'ACTIVE';
CREATE UNIQUE INDEX "test_catalogue_one_draft" ON "test_catalogue"("local_code") WHERE "status" = 'DRAFT';

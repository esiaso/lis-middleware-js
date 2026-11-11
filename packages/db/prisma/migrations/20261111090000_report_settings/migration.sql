-- The letterhead on printed lab reports (A-42). Expand-only: one new table
-- with at most one row; reports fall back to LIMS_REPORT_HEADER without it.
CREATE TABLE "report_settings" (
    "id" TEXT NOT NULL DEFAULT 'lab',
    "lab_name" TEXT NOT NULL,
    "subtitle" TEXT,
    "address" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "accreditation" TEXT,
    "report_title" TEXT NOT NULL,
    "footer_note" TEXT,
    "logo" BYTEA,
    "logo_type" TEXT,
    "logo_sha256" TEXT,
    "updated_by" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_settings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "report_settings_single_row_chk" CHECK ("id" = 'lab'),
    CONSTRAINT "report_settings_logo_chk" CHECK (("logo" IS NULL) = ("logo_type" IS NULL) AND ("logo" IS NULL) = ("logo_sha256" IS NULL)),
    CONSTRAINT "report_settings_logo_type_chk" CHECK ("logo_type" IN ('image/png', 'image/jpeg')),
    CONSTRAINT "report_settings_logo_size_chk" CHECK ("logo" IS NULL OR octet_length("logo") <= 262144)
);

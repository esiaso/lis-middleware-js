-- How the jobs worker's last HMIS polls went (07 §6.6), for the HMIS link page. Expand-only.
CREATE TABLE "hmis_poll_status" (
    "name" TEXT NOT NULL,
    "profile" TEXT NOT NULL,
    "last_attempt_at" TIMESTAMPTZ NOT NULL,
    "last_success_at" TIMESTAMPTZ,
    "last_received" INTEGER NOT NULL DEFAULT 0,
    "failures_in_a_row" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "last_error_at" TIMESTAMPTZ,
    CONSTRAINT "hmis_poll_status_pkey" PRIMARY KEY ("name"),
    CONSTRAINT "hmis_poll_status_counts_chk" CHECK ("last_received" >= 0 AND "failures_in_a_row" >= 0),
    CONSTRAINT "hmis_poll_status_error_chk" CHECK (char_length("last_error") <= 2000)
);

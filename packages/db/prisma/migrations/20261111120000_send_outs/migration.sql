-- Send-outs to referral labs (A-43). Expand-only: new tables, nothing changed.
CREATE TABLE "referral_lab" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "notes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" TEXT,
    "updated_at" TIMESTAMPTZ,
    CONSTRAINT "referral_lab_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "referral_lab_code_key" ON "referral_lab"("code");

CREATE TABLE "referral_test" (
    "id" UUID NOT NULL,
    "lab_id" UUID NOT NULL,
    "local_test_code" TEXT NOT NULL,
    "tat_hours" INTEGER NOT NULL,
    "specimen_note" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retired_by" TEXT,
    "retired_at" TIMESTAMPTZ,
    CONSTRAINT "referral_test_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "referral_test_tat_chk" CHECK ("tat_hours" BETWEEN 1 AND 2160),
    CONSTRAINT "referral_test_lab_id_fkey" FOREIGN KEY ("lab_id") REFERENCES "referral_lab"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "referral_test_local_test_code_idx" ON "referral_test"("local_test_code");
-- One active agreement per lab and test.
CREATE UNIQUE INDEX "referral_test_active_key" ON "referral_test"("lab_id", "local_test_code") WHERE "active";

CREATE TABLE "send_out" (
    "id" UUID NOT NULL,
    "specimen_id" UUID NOT NULL,
    "lab_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "dispatched_at" TIMESTAMPTZ NOT NULL,
    "dispatched_by" TEXT NOT NULL,
    "dispatch_ref" TEXT,
    "due_at" TIMESTAMPTZ NOT NULL,
    "lab_received_at" TIMESTAMPTZ,
    "lab_received_by" TEXT,
    "lab_ref" TEXT,
    "resulted_at" TIMESTAMPTZ,
    "cancelled_at" TIMESTAMPTZ,
    "cancelled_by" TEXT,
    "cancel_reason" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "send_out_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "send_out_status_chk" CHECK ("status" IN ('sent', 'received', 'resulted', 'cancelled')),
    CONSTRAINT "send_out_cancel_chk" CHECK (("status" = 'cancelled') = ("cancelled_at" IS NOT NULL)),
    CONSTRAINT "send_out_specimen_id_fkey" FOREIGN KEY ("specimen_id") REFERENCES "specimen"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "send_out_lab_id_fkey" FOREIGN KEY ("lab_id") REFERENCES "referral_lab"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "send_out_status_due_at_idx" ON "send_out"("status", "due_at");
CREATE INDEX "send_out_specimen_id_idx" ON "send_out"("specimen_id");

CREATE TABLE "send_out_test" (
    "id" UUID NOT NULL,
    "send_out_id" UUID NOT NULL,
    "ordered_test_id" UUID NOT NULL,
    "tat_hours" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "send_out_test_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "send_out_test_send_out_id_fkey" FOREIGN KEY ("send_out_id") REFERENCES "send_out"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "send_out_test_ordered_test_id_fkey" FOREIGN KEY ("ordered_test_id") REFERENCES "ordered_test"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "send_out_test_ordered_test_id_idx" ON "send_out_test"("ordered_test_id");
-- A test is on at most one send-out that is not cancelled.
CREATE UNIQUE INDEX "send_out_test_active_key" ON "send_out_test"("ordered_test_id") WHERE "active";

CREATE TABLE "send_out_document" (
    "id" UUID NOT NULL,
    "send_out_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "note" TEXT,
    "uploaded_by" TEXT NOT NULL,
    "uploaded_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "send_out_document_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "send_out_document_kind_chk" CHECK ("kind" IN ('receiving-report', 'result-report', 'other')),
    CONSTRAINT "send_out_document_type_chk" CHECK ("content_type" IN ('application/pdf', 'image/png', 'image/jpeg')),
    CONSTRAINT "send_out_document_size_chk" CHECK ("size" = octet_length("bytes") AND "size" <= 5242880),
    CONSTRAINT "send_out_document_send_out_id_fkey" FOREIGN KEY ("send_out_id") REFERENCES "send_out"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "send_out_document_send_out_id_idx" ON "send_out_document"("send_out_id");

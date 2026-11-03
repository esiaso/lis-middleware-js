-- CreateTable
CREATE TABLE "patient" (
    "id" UUID NOT NULL,
    "mrn" TEXT NOT NULL,
    "family_name" TEXT,
    "given_name" TEXT,
    "birth_date" DATE,
    "sex" TEXT,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "patient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lab_order" (
    "id" UUID NOT NULL,
    "hmis_order_id" TEXT NOT NULL,
    "patient_id" UUID NOT NULL,
    "hmis_encounter_id" TEXT,
    "location" TEXT,
    "priority" TEXT NOT NULL,
    "ordered_at" TIMESTAMPTZ NOT NULL,
    "ordering_clinician" TEXT,
    "status" TEXT NOT NULL,
    "source_json" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lab_order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ordered_test" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "hmis_line_id" TEXT NOT NULL,
    "hmis_test_code" TEXT NOT NULL,
    "local_test_code" TEXT,
    "specimen_type" TEXT,
    "status" TEXT NOT NULL,
    "specimen_id" UUID,

    CONSTRAINT "ordered_test_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hmis_code_map" (
    "hmis_test_code" TEXT NOT NULL,
    "local_test_code" TEXT NOT NULL,

    CONSTRAINT "hmis_code_map_pkey" PRIMARY KEY ("hmis_test_code")
);

-- CreateTable
CREATE TABLE "hmis_cursor" (
    "name" TEXT NOT NULL,
    "cursor" TEXT,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hmis_cursor_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "specimen" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "accession_no" TEXT NOT NULL,
    "barcode" TEXT NOT NULL,
    "barcode_active" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL,
    "collected_at" TIMESTAMPTZ,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "specimen_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "result" (
    "id" UUID NOT NULL,
    "ordered_test_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "selected_version_no" INTEGER,
    "reviewed_by" TEXT,
    "approved_by" TEXT,
    "release_count" INTEGER NOT NULL DEFAULT 0,
    "delivery_key" TEXT,
    "delivered_key" TEXT,
    "new_data_after_approval" BOOLEAN NOT NULL DEFAULT false,
    "needs_confirmation" BOOLEAN NOT NULL DEFAULT false,
    "instrument_id" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "result_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "result_version" (
    "id" UUID NOT NULL,
    "result_id" UUID NOT NULL,
    "version_no" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "units" TEXT,
    "abnormal_flags" TEXT[],
    "observation_id" UUID,
    "reason" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "result_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "result_event" (
    "id" UUID NOT NULL,
    "result_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "version_no" INTEGER,
    "actor" TEXT NOT NULL,
    "reason" TEXT,
    "detail" JSONB,
    "at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "result_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "unmatched_result" (
    "id" UUID NOT NULL,
    "observation_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "sample_id" TEXT,
    "instrument_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ,
    "resolved_by" TEXT,
    "resolution" TEXT,

    CONSTRAINT "unmatched_result_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_message" (
    "id" UUID NOT NULL,
    "topic" TEXT NOT NULL,
    "result_id" UUID,
    "version_no" INTEGER,
    "idempotency_key" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "QueueStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leased_by" TEXT,
    "lease_until" TIMESTAMPTZ,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_attempt" (
    "id" UUID NOT NULL,
    "outbox_id" UUID NOT NULL,
    "started_at" TIMESTAMPTZ NOT NULL,
    "finished_at" TIMESTAMPTZ NOT NULL,
    "outcome" TEXT NOT NULL,
    "detail" TEXT,

    CONSTRAINT "delivery_attempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_event" (
    "seq" BIGSERIAL NOT NULL,
    "id" UUID NOT NULL,
    "at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "reason" TEXT,
    "correlation_id" TEXT,
    "before" JSONB,
    "after" JSONB,
    "prev_hash" TEXT NOT NULL,
    "hash" TEXT NOT NULL,

    CONSTRAINT "audit_event_pkey" PRIMARY KEY ("seq")
);

-- CreateIndex
CREATE UNIQUE INDEX "patient_mrn_key" ON "patient"("mrn");

-- CreateIndex
CREATE UNIQUE INDEX "lab_order_hmis_order_id_key" ON "lab_order"("hmis_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "ordered_test_order_id_hmis_line_id_key" ON "ordered_test"("order_id", "hmis_line_id");

-- CreateIndex
CREATE UNIQUE INDEX "specimen_accession_no_key" ON "specimen"("accession_no");

-- CreateIndex
CREATE INDEX "specimen_barcode_idx" ON "specimen"("barcode");

-- CreateIndex
CREATE UNIQUE INDEX "result_ordered_test_id_key" ON "result"("ordered_test_id");

-- CreateIndex
CREATE INDEX "result_status_idx" ON "result"("status");

-- CreateIndex
CREATE UNIQUE INDEX "result_version_result_id_version_no_key" ON "result_version"("result_id", "version_no");

-- CreateIndex
CREATE INDEX "result_event_result_id_at_idx" ON "result_event"("result_id", "at");

-- CreateIndex
CREATE UNIQUE INDEX "unmatched_result_observation_id_key" ON "unmatched_result"("observation_id");

-- CreateIndex
CREATE INDEX "unmatched_result_resolved_at_idx" ON "unmatched_result"("resolved_at");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_message_idempotency_key_key" ON "outbox_message"("idempotency_key");

-- CreateIndex
CREATE INDEX "outbox_message_status_available_at_idx" ON "outbox_message"("status", "available_at");

-- CreateIndex
CREATE UNIQUE INDEX "audit_event_id_key" ON "audit_event"("id");

-- CreateIndex
CREATE INDEX "audit_event_entity_type_entity_id_idx" ON "audit_event"("entity_type", "entity_id");

-- AddForeignKey
ALTER TABLE "lab_order" ADD CONSTRAINT "lab_order_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ordered_test" ADD CONSTRAINT "ordered_test_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "lab_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ordered_test" ADD CONSTRAINT "ordered_test_specimen_id_fkey" FOREIGN KEY ("specimen_id") REFERENCES "specimen"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specimen" ADD CONSTRAINT "specimen_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "lab_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "result" ADD CONSTRAINT "result_ordered_test_id_fkey" FOREIGN KEY ("ordered_test_id") REFERENCES "ordered_test"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "result_version" ADD CONSTRAINT "result_version_result_id_fkey" FOREIGN KEY ("result_id") REFERENCES "result"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "result_event" ADD CONSTRAINT "result_event_result_id_fkey" FOREIGN KEY ("result_id") REFERENCES "result"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_attempt" ADD CONSTRAINT "delivery_attempt_outbox_id_fkey" FOREIGN KEY ("outbox_id") REFERENCES "outbox_message"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written (reviewed). See 06 §3.1 and 10 §8.
-- ---------------------------------------------------------------------------

-- One active barcode per value: a barcode is only ever reused after it is retired.
CREATE UNIQUE INDEX specimen_active_barcode_uq ON specimen (barcode) WHERE barcode_active;

-- Release requires approval (T-25): no result reaches the outbox, by any
-- path including direct SQL, unless that exact version was approved
-- (or approved as a correction) by a person.
CREATE FUNCTION outbox_requires_approval() RETURNS trigger AS $$
BEGIN
  IF NEW.topic LIKE 'hmis.result.%' THEN
    IF NEW.result_id IS NULL OR NEW.version_no IS NULL OR NOT EXISTS (
      SELECT 1 FROM result_event e
       WHERE e.result_id = NEW.result_id AND e.version_no = NEW.version_no AND e.kind IN ('approve', 'correct')
    ) THEN
      RAISE EXCEPTION 'release of result % version % without approval', NEW.result_id, NEW.version_no;
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER outbox_requires_approval_trg BEFORE INSERT ON outbox_message
  FOR EACH ROW EXECUTE FUNCTION outbox_requires_approval();

-- Append-only tables.
CREATE FUNCTION append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER audit_event_append_only BEFORE UPDATE OR DELETE ON audit_event FOR EACH ROW EXECUTE FUNCTION append_only();
CREATE TRIGGER result_event_append_only BEFORE UPDATE OR DELETE ON result_event FOR EACH ROW EXECUTE FUNCTION append_only();
CREATE TRIGGER result_version_append_only BEFORE UPDATE OR DELETE ON result_version FOR EACH ROW EXECUTE FUNCTION append_only();

-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('UNVERIFIED', 'VENDOR_TESTED', 'LAB_ACCEPTED', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "MappingStatus" AS ENUM ('DRAFT', 'APPROVED', 'ACTIVE', 'RETIRED');

-- CreateEnum
CREATE TYPE "Direction" AS ENUM ('IN', 'OUT');

-- CreateEnum
CREATE TYPE "TransportAck" AS ENUM ('PENDING', 'ACKED', 'NAKED', 'NOT_APPLICABLE');

-- CreateEnum
CREATE TYPE "QueueStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'DONE', 'FAILED', 'DEAD');

-- CreateTable
CREATE TABLE "instrument" (
    "id" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "manufacturer" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "serial_no" TEXT,
    "software_version" TEXT,
    "verified_software_version" TEXT,
    "discipline" TEXT NOT NULL,
    "location" TEXT,
    "interface_manual_ref" TEXT,
    "verification_status" "VerificationStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "instrument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "instrument_verification_evidence" (
    "id" UUID NOT NULL,
    "instrument_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "evidence_json" JSONB NOT NULL,
    "from_status" "VerificationStatus" NOT NULL,
    "to_status" "VerificationStatus" NOT NULL,
    "recorded_by" TEXT NOT NULL,
    "recorded_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "instrument_verification_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "instrument_connection" (
    "id" UUID NOT NULL,
    "instrument_id" TEXT NOT NULL,
    "config_json" JSONB NOT NULL,
    "active_from" TIMESTAMPTZ NOT NULL,
    "active_to" TIMESTAMPTZ,
    "created_by" TEXT NOT NULL,

    CONSTRAINT "instrument_connection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "instrument_connection_lease" (
    "instrument_id" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "epoch" BIGINT NOT NULL DEFAULT 0,
    "lease_until" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "instrument_connection_lease_pkey" PRIMARY KEY ("instrument_id")
);

-- CreateTable
CREATE TABLE "test_mapping_set" (
    "id" UUID NOT NULL,
    "instrument_id" TEXT NOT NULL,
    "version_no" INTEGER NOT NULL,
    "status" "MappingStatus" NOT NULL,
    "created_by" TEXT NOT NULL,
    "approved_by" TEXT,
    "approved_at" TIMESTAMPTZ,
    "active_from" TIMESTAMPTZ,
    "mappings_json" JSONB NOT NULL,

    CONSTRAINT "test_mapping_set_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "link_session" (
    "id" UUID NOT NULL,
    "instrument_id" TEXT NOT NULL,
    "lease_epoch" BIGINT NOT NULL,
    "owner" TEXT NOT NULL,
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ,
    "end_reason" TEXT,

    CONSTRAINT "link_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "raw_message" (
    "id" UUID NOT NULL,
    "instrument_id" TEXT NOT NULL,
    "lease_epoch" BIGINT NOT NULL,
    "link_session_id" UUID,
    "direction" "Direction" NOT NULL,
    "protocol" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "sha256" TEXT NOT NULL,
    "complete" BOOLEAN NOT NULL,
    "aborted_reason" TEXT,
    "received_at" TIMESTAMPTZ NOT NULL,
    "transport_ack" "TransportAck" NOT NULL,
    "dedupe_key" TEXT,

    CONSTRAINT "raw_message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "raw_frame" (
    "id" UUID NOT NULL,
    "instrument_id" TEXT NOT NULL,
    "lease_epoch" BIGINT NOT NULL,
    "link_session_id" UUID NOT NULL,
    "raw_message_id" UUID,
    "seq" INTEGER NOT NULL,
    "fn" INTEGER NOT NULL,
    "bytes" BYTEA NOT NULL,
    "final" BOOLEAN NOT NULL,
    "received_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "raw_frame_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inbox_message" (
    "id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "payload" JSONB,
    "raw_message_id" UUID,
    "status" "QueueStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leased_by" TEXT,
    "lease_until" TIMESTAMPTZ,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inbox_message_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "instrument_verification_evidence_instrument_id_recorded_at_idx" ON "instrument_verification_evidence"("instrument_id", "recorded_at");

-- CreateIndex
CREATE INDEX "instrument_connection_instrument_id_active_from_idx" ON "instrument_connection"("instrument_id", "active_from");

-- CreateIndex
CREATE UNIQUE INDEX "test_mapping_set_instrument_id_version_no_key" ON "test_mapping_set"("instrument_id", "version_no");

-- CreateIndex
CREATE INDEX "link_session_instrument_id_started_at_idx" ON "link_session"("instrument_id", "started_at");

-- CreateIndex
CREATE INDEX "raw_message_instrument_id_received_at_idx" ON "raw_message"("instrument_id", "received_at");

-- CreateIndex
CREATE INDEX "raw_message_sha256_idx" ON "raw_message"("sha256");

-- CreateIndex
CREATE UNIQUE INDEX "raw_frame_link_session_id_seq_key" ON "raw_frame"("link_session_id", "seq");

-- CreateIndex
CREATE INDEX "inbox_message_status_available_at_idx" ON "inbox_message"("status", "available_at");

-- CreateIndex
CREATE UNIQUE INDEX "inbox_message_source_external_id_key" ON "inbox_message"("source", "external_id");

-- AddForeignKey
ALTER TABLE "instrument_verification_evidence" ADD CONSTRAINT "instrument_verification_evidence_instrument_id_fkey" FOREIGN KEY ("instrument_id") REFERENCES "instrument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "instrument_connection" ADD CONSTRAINT "instrument_connection_instrument_id_fkey" FOREIGN KEY ("instrument_id") REFERENCES "instrument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "instrument_connection_lease" ADD CONSTRAINT "instrument_connection_lease_instrument_id_fkey" FOREIGN KEY ("instrument_id") REFERENCES "instrument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_mapping_set" ADD CONSTRAINT "test_mapping_set_instrument_id_fkey" FOREIGN KEY ("instrument_id") REFERENCES "instrument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raw_message" ADD CONSTRAINT "raw_message_link_session_id_fkey" FOREIGN KEY ("link_session_id") REFERENCES "link_session"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raw_frame" ADD CONSTRAINT "raw_frame_link_session_id_fkey" FOREIGN KEY ("link_session_id") REFERENCES "link_session"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raw_frame" ADD CONSTRAINT "raw_frame_raw_message_id_fkey" FOREIGN KEY ("raw_message_id") REFERENCES "raw_message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written (reviewed): fencing. See docs/design/03 "Single owner per
-- instrument" and 06 §3.1. A worker that lost its lease (paused process,
-- second copy) cannot store frames or messages, so it can never ACK them.
-- ---------------------------------------------------------------------------
CREATE FUNCTION analyzer_fence() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM instrument_connection_lease l
    WHERE l.instrument_id = NEW.instrument_id
      AND l.epoch = NEW.lease_epoch
      AND l.lease_until > now()
  ) THEN
    RAISE EXCEPTION 'stale or expired lease epoch % for instrument %', NEW.lease_epoch, NEW.instrument_id
      USING ERRCODE = 'P0001', HINT = 'lims:stale-lease';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER raw_message_fence_trg BEFORE INSERT ON raw_message
  FOR EACH ROW WHEN (NEW.direction = 'IN') EXECUTE FUNCTION analyzer_fence();

CREATE TRIGGER raw_frame_fence_trg BEFORE INSERT ON raw_frame
  FOR EACH ROW EXECUTE FUNCTION analyzer_fence();

-- Raw data is evidence: never updated or deleted. The one exception is
-- linking a stored frame to its assembled message, once.
CREATE FUNCTION raw_message_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'raw_message rows are immutable';
END $$ LANGUAGE plpgsql;

CREATE FUNCTION raw_frame_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.raw_message_id IS NULL AND NEW.raw_message_id IS NOT NULL
     AND NEW.bytes = OLD.bytes AND NEW.seq = OLD.seq AND NEW.fn = OLD.fn AND NEW.final = OLD.final
     AND NEW.lease_epoch = OLD.lease_epoch AND NEW.link_session_id = OLD.link_session_id
     AND NEW.received_at = OLD.received_at AND NEW.instrument_id = OLD.instrument_id THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'raw_frame rows are immutable';
END $$ LANGUAGE plpgsql;

CREATE TRIGGER raw_message_immutable_trg BEFORE UPDATE OR DELETE ON raw_message
  FOR EACH ROW EXECUTE FUNCTION raw_message_immutable();
CREATE TRIGGER raw_frame_immutable_trg BEFORE UPDATE OR DELETE ON raw_frame
  FOR EACH ROW EXECUTE FUNCTION raw_frame_immutable();

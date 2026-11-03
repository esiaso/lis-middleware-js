-- CreateEnum
CREATE TYPE "ObservationMapping" AS ENUM ('MAPPED', 'UNMAPPED', 'NOT_REPORTABLE', 'QC');

-- CreateTable
CREATE TABLE "normalized_message" (
    "id" UUID NOT NULL,
    "raw_message_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "instrument_id" TEXT NOT NULL,
    "adapter_name" TEXT NOT NULL,
    "adapter_version" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "sample_class" TEXT NOT NULL,
    "sample_id" TEXT,
    "sample_id_read_error" BOOLEAN NOT NULL,
    "mapping_version_no" INTEGER,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "normalized_message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "observation" (
    "id" UUID NOT NULL,
    "normalized_message_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "instrument_test_code" TEXT NOT NULL,
    "instrument_code_system" TEXT,
    "original_value_text" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "numeric_value" DECIMAL(30,10),
    "units" TEXT,
    "abnormal_flags" TEXT[],
    "mapping" "ObservationMapping" NOT NULL,
    "local_test_code" TEXT,

    CONSTRAINT "observation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "normalized_message_instrument_id_sample_id_idx" ON "normalized_message"("instrument_id", "sample_id");

-- CreateIndex
CREATE UNIQUE INDEX "normalized_message_raw_message_id_seq_key" ON "normalized_message"("raw_message_id", "seq");

-- CreateIndex
CREATE INDEX "observation_mapping_idx" ON "observation"("mapping");

-- CreateIndex
CREATE UNIQUE INDEX "observation_normalized_message_id_seq_key" ON "observation"("normalized_message_id", "seq");

-- AddForeignKey
ALTER TABLE "observation" ADD CONSTRAINT "observation_normalized_message_id_fkey" FOREIGN KEY ("normalized_message_id") REFERENCES "normalized_message"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Patient merges recorded by the lab (D-6, A-35). Expand-only.
-- When medical records merge two MRNs in the HMIS, the lab records it here: one person
-- proposes, a different person confirms. Orders and results keep the MRN they arrived
-- with; the history, cumulative report and delta checks of the surviving patient include
-- the merged one. Nothing is deleted.
CREATE TABLE "patient_merge" (
    "id" UUID NOT NULL,
    "from_patient_id" UUID NOT NULL,
    "into_patient_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PROPOSED',
    -- Where the merge was decided: the HMIS or medical records reference.
    "reference" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "proposed_by" TEXT NOT NULL,
    "proposed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_by" TEXT,
    "decided_at" TIMESTAMPTZ,
    CONSTRAINT "patient_merge_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "patient_merge_status_chk" CHECK ("status" IN ('PROPOSED', 'CONFIRMED', 'WITHDRAWN')),
    CONSTRAINT "patient_merge_self_chk" CHECK ("from_patient_id" <> "into_patient_id"),
    CONSTRAINT "patient_merge_decided_chk" CHECK ("status" = 'PROPOSED' OR ("decided_by" IS NOT NULL AND "decided_at" IS NOT NULL)),
    -- Nobody confirms their own merge.
    CONSTRAINT "patient_merge_two_person_chk" CHECK ("status" <> 'CONFIRMED' OR "decided_by" <> "proposed_by")
);
ALTER TABLE "patient_merge" ADD CONSTRAINT "patient_merge_from_fkey" FOREIGN KEY ("from_patient_id") REFERENCES "patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "patient_merge" ADD CONSTRAINT "patient_merge_into_fkey" FOREIGN KEY ("into_patient_id") REFERENCES "patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- At most one open or confirmed merge for each patient merged away.
CREATE UNIQUE INDEX "patient_merge_one_per_from" ON "patient_merge"("from_patient_id") WHERE "status" IN ('PROPOSED', 'CONFIRMED');
CREATE INDEX "patient_merge_into" ON "patient_merge"("into_patient_id");

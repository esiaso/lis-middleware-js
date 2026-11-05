-- Quality control for tests read by a person (design: "Manual tests", A-33). Expand-only.
-- Each manual test or panel in the catalogue says whether entering a result needs
-- a passing control for the kit, strip or stain lot used: NONE, WARN or BLOCK.
ALTER TABLE "test_catalogue" ADD COLUMN "qc_rule" TEXT NOT NULL DEFAULT 'NONE';
-- How long a passing control counts, in hours; null means for the whole lot.
ALTER TABLE "test_catalogue" ADD COLUMN "qc_valid_hours" INTEGER;
ALTER TABLE "test_catalogue" ADD CONSTRAINT "test_catalogue_qc_rule_chk" CHECK ("qc_rule" IN ('NONE', 'WARN', 'BLOCK'));
ALTER TABLE "test_catalogue" ADD CONSTRAINT "test_catalogue_qc_hours_chk" CHECK ("qc_valid_hours" IS NULL OR "qc_valid_hours" BETWEEN 1 AND 8760);
ALTER TABLE "test_catalogue" ADD CONSTRAINT "test_catalogue_qc_manual_chk" CHECK ("qc_rule" = 'NONE' OR "performed_by" = 'MANUAL');

-- One control run on a lot: a positive or negative control, a known slide, a dipstick control.
-- Append-only: a mistake is corrected by running and recording the control again.
CREATE TABLE "manual_qc" (
    "id" UUID NOT NULL,
    "local_code" TEXT NOT NULL,
    "catalogue_version" INTEGER NOT NULL,
    "lot" TEXT NOT NULL,
    "lot_expiry" DATE,
    "control" TEXT NOT NULL,
    "expected" TEXT NOT NULL,
    "observed" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "comment" TEXT,
    "performed_by" TEXT NOT NULL,
    "entered_by" TEXT NOT NULL,
    "at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "manual_qc_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "manual_qc_outcome_chk" CHECK ("outcome" IN ('PASS', 'FAIL')),
    CONSTRAINT "manual_qc_lot_chk" CHECK (length("lot") BETWEEN 1 AND 40),
    CONSTRAINT "manual_qc_control_chk" CHECK (length("control") BETWEEN 1 AND 60)
);
CREATE INDEX "manual_qc_code_lot_at" ON "manual_qc"("local_code", "lot", "at");
CREATE INDEX "manual_qc_at" ON "manual_qc"("at");
CREATE TRIGGER manual_qc_append_only BEFORE UPDATE OR DELETE ON manual_qc FOR EACH ROW EXECUTE FUNCTION append_only();

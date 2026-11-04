-- Autoverification rules and decisions (08 §12, A-19). Expand-only. No rules are shipped.
CREATE TABLE "autoverify_rule" (
    "id" UUID NOT NULL,
    "local_test_code" TEXT NOT NULL,
    "low" TEXT NOT NULL,
    "high" TEXT NOT NULL,
    "units" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "qc_acknowledged" BOOLEAN NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retired_by" TEXT,
    "retired_at" TIMESTAMPTZ,
    "retire_reason" TEXT,
    CONSTRAINT "autoverify_rule_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "autoverify_rule_decimal_chk" CHECK ("low" ~ '^[+-]?\d+(\.\d+)?$' AND "high" ~ '^[+-]?\d+(\.\d+)?$'),
    CONSTRAINT "autoverify_rule_order_chk" CHECK ("low"::numeric <= "high"::numeric),
    CONSTRAINT "autoverify_rule_qc_chk" CHECK ("qc_acknowledged"),
    CONSTRAINT "autoverify_rule_retired_chk" CHECK ("active" OR ("retired_by" IS NOT NULL AND "retired_at" IS NOT NULL))
);
CREATE INDEX "autoverify_rule_local_test_code_active_idx" ON "autoverify_rule"("local_test_code", "active");
-- One active rule per test, so there is never a question of which one applied.
CREATE UNIQUE INDEX "autoverify_rule_one_active" ON "autoverify_rule"("local_test_code") WHERE "active";

CREATE TABLE "autoverification_decision" (
    "id" UUID NOT NULL,
    "result_id" UUID NOT NULL,
    "version_no" INTEGER NOT NULL,
    "rule_id" UUID NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "checks" JSONB NOT NULL,
    "at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "autoverification_decision_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "autoverification_decision_result_id_idx" ON "autoverification_decision"("result_id");
ALTER TABLE "autoverification_decision" ADD CONSTRAINT "autoverification_decision_result_id_fkey" FOREIGN KEY ("result_id") REFERENCES "result"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "autoverification_decision" ADD CONSTRAINT "autoverification_decision_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "autoverify_rule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TRIGGER autoverification_decision_append_only BEFORE UPDATE OR DELETE ON autoverification_decision FOR EACH ROW EXECUTE FUNCTION append_only();

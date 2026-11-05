-- Panels (design: "Test catalogue and LOINC", A-32). Expand-only: existing rows keep their meaning.
-- A panel is a catalogue entry listing its component tests.
ALTER TABLE "test_catalogue" ADD COLUMN "components" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "test_catalogue" DROP CONSTRAINT "test_catalogue_type_chk";
ALTER TABLE "test_catalogue" ADD CONSTRAINT "test_catalogue_type_chk" CHECK ("result_type" IN ('NUMERIC', 'ORDINAL', 'NOMINAL', 'TEXT', 'PANEL'));

-- An HMIS order line for a panel becomes one ordered test per component.
-- component_code is '' for an ordinary line, so the uniqueness below still holds one row per plain line.
ALTER TABLE "ordered_test" ADD COLUMN "component_code" TEXT NOT NULL DEFAULT '';
ALTER TABLE "ordered_test" ADD COLUMN "panel_code" TEXT;
ALTER TABLE "ordered_test" ADD CONSTRAINT "ordered_test_component_chk" CHECK (("component_code" = '') = ("panel_code" IS NULL));
CREATE UNIQUE INDEX "ordered_test_order_id_hmis_line_id_component_code_key" ON "ordered_test"("order_id", "hmis_line_id", "component_code");
DROP INDEX "ordered_test_order_id_hmis_line_id_key";

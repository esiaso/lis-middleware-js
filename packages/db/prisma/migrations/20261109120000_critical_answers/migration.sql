-- Critical answers for choice tests (A-36): a catalogue answer the lab director
-- marks critical flags the version 'ANSWER', which needs a recorded call like
-- LOW and HIGH. Widening the check is safe: no existing row changes.
ALTER TABLE "result_version" DROP CONSTRAINT "result_version_critical_flag_chk";
ALTER TABLE "result_version" ADD CONSTRAINT "result_version_critical_flag_chk" CHECK ("critical_flag" IS NULL OR "critical_flag" IN ('LOW', 'HIGH', 'UNITS_DIFFER', 'ANSWER'));

import type { ResultValue } from '@lis/contracts';
import type { Db } from '@lis/db';
import type { Tx } from './tx.js';

/** One result in a patient's history: its selected version and where it came from. */
export interface HistoryResult {
  resultId: string;
  orderId: string;
  hmisOrderId: string;
  test: string;
  status: string;
  /** Collection time, or the order time when there is none. */
  at: Date;
  collected: boolean;
  value: ResultValue | null;
  units: string | null;
  abnormalFlags: string[];
  criticalFlag: string | null;
  deltaFlag: string | null;
}

/** Statuses after approval by a person or by autoverification. */
export const APPROVED_STATUSES = ['approved', 'queued', 'sent', 'hmis_confirmed', 'failed', 'corrected'];

/** A patient's results, newest first, at most `limit`. */
export async function patientHistory(db: Db | Tx, patientId: string, limit = 500): Promise<HistoryResult[]> {
  return db.$queryRaw<HistoryResult[]>`
    SELECT r.id AS "resultId", o.id AS "orderId", o.hmis_order_id AS "hmisOrderId", COALESCE(t.local_test_code, t.hmis_test_code) AS test,
           r.status::text AS status, COALESCE(s.collected_at, o.ordered_at) AS at, s.collected_at IS NOT NULL AS collected,
           v.value, v.units, COALESCE(v.abnormal_flags, ARRAY[]::text[]) AS "abnormalFlags", v.critical_flag AS "criticalFlag", v.delta_flag AS "deltaFlag"
      FROM result r
      JOIN ordered_test t ON t.id = r.ordered_test_id
      JOIN lab_order o ON o.id = t.order_id
      LEFT JOIN specimen s ON s.id = t.specimen_id
      LEFT JOIN result_version v ON v.result_id = r.id AND v.version_no = r.selected_version_no
     WHERE o.patient_id = ${patientId}::uuid
     ORDER BY COALESCE(s.collected_at, o.ordered_at) DESC, r.id DESC
     LIMIT ${limit}`;
}

import type { Db } from '@lis/db';
import type { Tx } from './tx.js';

/**
 * Workload (W-16): what the instruments measured, from records the
 * middleware already keeps. Nothing is estimated.
 *
 * - A **measurement** is an instrument value stored on a patient result (a
 *   result version that came from an instrument observation), counted on
 *   day the instrument's message arrived, in the lab's time zone (A-24). Values typed or corrected
 *   by a person are not measurements.
 * - A **repeat** is any measurement after the first on the same result.
 * - **QC** counts QC observations kept in the QC log.
 * - **Quarantined** counts patient observations that arrived with no
 *   matching order. Some are attached to an order later and then also count
 *   as measurements, so it is shown beside the total, never added to it.
 */
export interface WorkloadCell {
  day: string;
  instrumentId: string;
  test: string;
  measurements: number;
  repeats: number;
}

export interface WorkloadInstrument {
  instrumentId: string;
  name: string;
  measurements: number;
  repeats: number;
  qc: number;
  quarantined: number;
}

export interface Workload {
  cells: WorkloadCell[];
  instruments: WorkloadInstrument[];
  tests: { test: string; measurements: number; repeats: number; byInstrument: Record<string, number> }[];
  days: { day: string; measurements: number; repeats: number; qc: number }[];
  total: { measurements: number; repeats: number; qc: number; quarantined: number };
}

/** Measurements per day (in the given time zone), instrument and test, in [from, to). */
export async function workloadCells(db: Db | Tx, from: Date, to: Date, timeZone = 'UTC'): Promise<WorkloadCell[]> {
  const rows = await db.$queryRaw<{ day: string; instrumentId: string; test: string; measurements: bigint; repeats: bigint }[]>`
    SELECT to_char(nm.created_at AT TIME ZONE ${timeZone}, 'YYYY-MM-DD') AS day, nm.instrument_id AS "instrumentId",
           COALESCE(t.local_test_code, t.hmis_test_code) AS test,
           count(*) AS measurements,
           count(*) FILTER (WHERE EXISTS (
             SELECT 1 FROM result_version e
              WHERE e.result_id = v.result_id AND e.observation_id IS NOT NULL AND e.version_no < v.version_no)) AS repeats
      FROM result_version v
      JOIN observation ob ON ob.id = v.observation_id
      JOIN normalized_message nm ON nm.id = ob.normalized_message_id
      JOIN result r ON r.id = v.result_id
      JOIN ordered_test t ON t.id = r.ordered_test_id
     WHERE nm.created_at >= ${from} AND nm.created_at < ${to}
     GROUP BY 1, 2, 3
     ORDER BY 1, 2, 3`;
  return rows.map((r) => ({ ...r, measurements: Number(r.measurements), repeats: Number(r.repeats) }));
}

export async function workload(db: Db | Tx, from: Date, to: Date, timeZone = 'UTC'): Promise<Workload> {
  const [cells, qc, quarantined, names] = await Promise.all([
    workloadCells(db, from, to, timeZone),
    db.$queryRaw<{ day: string; instrumentId: string; n: bigint }[]>`
      SELECT to_char(at AT TIME ZONE ${timeZone}, 'YYYY-MM-DD') AS day, instrument_id AS "instrumentId", count(*) AS n
        FROM qc_evaluation WHERE at >= ${from} AND at < ${to} GROUP BY 1, 2`,
    db.$queryRaw<{ instrumentId: string; n: bigint }[]>`
      SELECT instrument_id AS "instrumentId", count(*) AS n
        FROM unmatched_result WHERE created_at >= ${from} AND created_at < ${to} GROUP BY 1`,
    db.instrument.findMany({ select: { id: true, displayName: true } }),
  ]);
  const name = new Map(names.map((i) => [i.id, i.displayName]));
  const inst = new Map<string, WorkloadInstrument>();
  const get = (id: string) => {
    let x = inst.get(id);
    if (!x) inst.set(id, (x = { instrumentId: id, name: name.get(id) ?? id, measurements: 0, repeats: 0, qc: 0, quarantined: 0 }));
    return x;
  };
  const tests = new Map<string, Workload['tests'][number]>();
  const days = new Map<string, Workload['days'][number]>();
  const dayOf = (d: string) => {
    let x = days.get(d);
    if (!x) days.set(d, (x = { day: d, measurements: 0, repeats: 0, qc: 0 }));
    return x;
  };
  for (const c of cells) {
    const i = get(c.instrumentId);
    i.measurements += c.measurements;
    i.repeats += c.repeats;
    let t = tests.get(c.test);
    if (!t) tests.set(c.test, (t = { test: c.test, measurements: 0, repeats: 0, byInstrument: {} }));
    t.measurements += c.measurements;
    t.repeats += c.repeats;
    t.byInstrument[c.instrumentId] = (t.byInstrument[c.instrumentId] ?? 0) + c.measurements;
    const d = dayOf(c.day);
    d.measurements += c.measurements;
    d.repeats += c.repeats;
  }
  for (const q of qc) {
    get(q.instrumentId).qc += Number(q.n);
    dayOf(q.day).qc += Number(q.n);
  }
  for (const q of quarantined) get(q.instrumentId).quarantined += Number(q.n);
  const instruments = [...inst.values()].sort((a, b) => a.name.localeCompare(b.name));
  return {
    cells,
    instruments,
    tests: [...tests.values()].sort((a, b) => b.measurements - a.measurements || a.test.localeCompare(b.test)),
    days: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)),
    total: instruments.reduce((s, i) => ({ measurements: s.measurements + i.measurements, repeats: s.repeats + i.repeats, qc: s.qc + i.qc, quarantined: s.quarantined + i.quarantined }), { measurements: 0, repeats: 0, qc: 0, quarantined: 0 }),
  };
}

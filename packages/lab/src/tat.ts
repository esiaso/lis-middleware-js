import type { Db } from '@lis/db';
import { InvalidInput } from './instruments.js';
import type { Tx } from './tx.js';

/**
 * Turnaround times (09, A-22). Built only from timestamps the middleware
 * already keeps; nothing is estimated. Each step uses the first time it
 * happened (first value, first approval, first release, first accepted
 * delivery), so a correction or a resend does not move the original times.
 * A step with a missing time, or one that would be negative (a clock set
 * wrong, a collection time typed after receipt), is left out of that step's
 * figures only, and counted.
 */
export const TAT_STEPS = [
  { key: 'ordered_collected', from: 'ordered', to: 'collected', label: 'Ordered to collected' },
  { key: 'collected_received', from: 'collected', to: 'received', label: 'Collected to received in the lab' },
  { key: 'received_first', from: 'received', to: 'first_value', label: 'Received to first value' },
  { key: 'first_approved', from: 'first_value', to: 'approved', label: 'First value to approved' },
  { key: 'approved_released', from: 'approved', to: 'released', label: 'Approved to released' },
  { key: 'released_accepted', from: 'released', to: 'accepted', label: 'Released to accepted by the HMIS' },
  { key: 'collected_accepted', from: 'collected', to: 'accepted', label: 'Collected to accepted by the HMIS (total)' },
] as const;

export interface TatFilter {
  from: Date;
  /** Exclusive. */
  to: Date;
  priority: string | null;
}

export interface TatStep {
  n: number;
  median: number | null;
  p90: number | null;
  /** Times present but negative, left out. */
  negative: number;
}

export interface TatRow {
  test: string;
  results: number;
  steps: Record<(typeof TAT_STEPS)[number]['key'], TatStep>;
}

export interface TatResultTimes {
  accessionNo: string | null;
  test: string;
  priority: string;
  ordered: Date | null;
  collected: Date | null;
  received: Date | null;
  first_value: Date | null;
  approved: Date | null;
  approvedBy: string | null;
  released: Date | null;
  accepted: Date | null;
}

/** Parse the report's date range: YYYY-MM-DD in UTC, both days included, at most 366 days. */
export function parseTatFilter(q: { from?: string | undefined; to?: string | undefined; priority?: string | undefined }, now = new Date()): TatFilter {
  const day = (s: string | undefined, fallback: Date) => {
    if (!s) return fallback;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) throw new InvalidInput([`"${s.slice(0, 20)}" is not a date such as 2026-11-04.`]);
    return new Date(`${s}T00:00:00Z`);
  };
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const from = day(q.from, new Date(today.getTime() - 6 * 86_400_000));
  const to = new Date(day(q.to, today).getTime() + 86_400_000);
  if (from >= to) throw new InvalidInput(['The first day must not be after the last day.']);
  if (to.getTime() - from.getTime() > 366 * 86_400_000) throw new InvalidInput(['Choose at most 366 days.']);
  const priority = q.priority && ['routine', 'urgent', 'stat'].includes(q.priority) ? q.priority : null;
  return { from, to, priority };
}

/** One row per result whose specimen was collected (or, without a collection time, ordered) in the range. */
export async function tatTimes(db: Db | Tx, f: TatFilter, limit = 50_000): Promise<TatResultTimes[]> {
  return db.$queryRaw<TatResultTimes[]>`
    SELECT s.accession_no AS "accessionNo", COALESCE(t.local_test_code, t.hmis_test_code) AS test, o.priority::text AS priority,
           o.ordered_at AS ordered, s.collected_at AS collected, s.received_at AS received,
           (SELECT min(v.created_at) FROM result_version v WHERE v.result_id = r.id) AS first_value,
           a.at AS approved, a.actor AS "approvedBy",
           (SELECT min(e.at) FROM result_event e WHERE e.result_id = r.id AND e.kind = 'release') AS released,
           (SELECT min(e.at) FROM result_event e WHERE e.result_id = r.id AND e.kind = 'delivery' AND e.detail->>'status' IN ('sent', 'hmis_confirmed')) AS accepted
      FROM result r
      JOIN ordered_test t ON t.id = r.ordered_test_id
      JOIN lab_order o ON o.id = t.order_id
      LEFT JOIN specimen s ON s.id = t.specimen_id
      LEFT JOIN LATERAL (SELECT e.at, e.actor FROM result_event e WHERE e.result_id = r.id AND e.kind = 'approve' ORDER BY e.at ASC LIMIT 1) a ON true
     WHERE COALESCE(s.collected_at, o.ordered_at) >= ${f.from} AND COALESCE(s.collected_at, o.ordered_at) < ${f.to}
       AND (${f.priority}::text IS NULL OR o.priority::text = ${f.priority})
     ORDER BY COALESCE(s.collected_at, o.ordered_at) ASC, r.id ASC
     LIMIT ${limit}`;
}

/** Nearest-rank percentile of sorted seconds. */
function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!;
}

export function summarizeTat(rows: TatResultTimes[]): { all: TatRow; tests: TatRow[] } {
  const group = (test: string, list: TatResultTimes[]): TatRow => {
    const steps = {} as TatRow['steps'];
    for (const s of TAT_STEPS) {
      const secs: number[] = [];
      let negative = 0;
      for (const r of list) {
        const a = r[s.from];
        const b = r[s.to];
        if (!a || !b) continue;
        const d = (b.getTime() - a.getTime()) / 1000;
        if (d < 0) negative++;
        else secs.push(d);
      }
      secs.sort((x, y) => x - y);
      steps[s.key] = { n: secs.length, median: percentile(secs, 0.5), p90: percentile(secs, 0.9), negative };
    }
    return { test, results: list.length, steps };
  };
  const byTest = new Map<string, TatResultTimes[]>();
  for (const r of rows) byTest.set(r.test, [...(byTest.get(r.test) ?? []), r]);
  return { all: group('All tests', rows), tests: [...byTest.keys()].sort().map((t) => group(t, byTest.get(t)!)) };
}

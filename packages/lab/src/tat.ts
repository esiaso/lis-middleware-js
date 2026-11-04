import { uuidv7, type Db } from '@lis/db';
import { parseTatTarget, targetFor, type TatTarget, type TatTargetInput } from '@lis/domain';
import { appendAudit } from './audit.js';
import { WorkflowRejected } from './results.js';
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

export interface TatTargetCount {
  /** Results with a target and a receipt time. */
  counted: number;
  /** Released within the target. */
  met: number;
  /** Released after the target, or not released and already past it. */
  late: number;
}

export interface TatRow {
  test: string;
  results: number;
  target: TatTargetCount;
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

export function summarizeTat(rows: TatResultTimes[], targets: TatTarget[] = [], now = new Date()): { all: TatRow; tests: TatRow[] } {
  const group = (test: string, list: TatResultTimes[]): TatRow => {
    const target: TatTargetCount = { counted: 0, met: 0, late: 0 };
    for (const r of list) {
      const t = targetFor(targets, r.test, r.priority);
      if (!t || !r.received) continue;
      target.counted++;
      const due = r.received.getTime() + t.minutes * 60_000;
      if (r.released) {
        if (r.released.getTime() <= due) target.met++;
        else target.late++;
      } else if (now.getTime() > due) target.late++;
    }
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
    return { test, results: list.length, target, steps };
  };
  const byTest = new Map<string, TatResultTimes[]>();
  for (const r of rows) byTest.set(r.test, [...(byTest.get(r.test) ?? []), r]);
  return { all: group('All tests', rows), tests: [...byTest.keys()].sort().map((t) => group(t, byTest.get(t)!)) };
}

export interface OverdueResult {
  resultId: string;
  test: string;
  priority: string;
  accessionNo: string | null;
  mrn: string;
  familyName: string | null;
  givenName: string | null;
  status: string;
  received: Date;
  due: Date;
  targetMinutes: number;
}

/** Results not yet released whose receipt-to-release target has passed, most overdue first. */
export async function overdueResults(db: Db | Tx, now = new Date()): Promise<OverdueResult[]> {
  const targets = await db.tatTarget.findMany({ where: { active: true } });
  if (!targets.length) return [];
  const rows = await db.$queryRaw<Omit<OverdueResult, 'due' | 'targetMinutes'>[]>`
    SELECT r.id AS "resultId", COALESCE(t.local_test_code, t.hmis_test_code) AS test, o.priority::text AS priority, s.accession_no AS "accessionNo",
           p.mrn, p.family_name AS "familyName", p.given_name AS "givenName", r.status::text AS status, s.received_at AS received
      FROM result r
      JOIN ordered_test t ON t.id = r.ordered_test_id
      JOIN lab_order o ON o.id = t.order_id
      JOIN patient p ON p.id = o.patient_id
      JOIN specimen s ON s.id = t.specimen_id
     WHERE r.status IN ('received', 'reviewed', 'approved')
       AND s.received_at IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM result_event e WHERE e.result_id = r.id AND e.kind = 'release')
     ORDER BY s.received_at ASC
     LIMIT 5000`;
  const out: OverdueResult[] = [];
  for (const r of rows) {
    const t = targetFor(targets, r.test, r.priority);
    if (!t) continue;
    const due = new Date(r.received.getTime() + t.minutes * 60_000);
    if (due < now) out.push({ ...r, due, targetMinutes: t.minutes });
  }
  return out.sort((a, b) => a.due.getTime() - b.due.getTime());
}

export async function addTatTarget(db: Db, actor: string, input: TatTargetInput): Promise<string> {
  const p = parseTatTarget(input);
  if (!p.ok) throw new InvalidInput(p.issues);
  const id = uuidv7();
  await db.$transaction(async (tx) => {
    if (await tx.tatTarget.findFirst({ where: { localTestCode: p.value.localTestCode, priority: p.value.priority, active: true } })) {
      throw new InvalidInput(['There is already an active target for that test and priority. Retire it first.']);
    }
    await tx.tatTarget.create({ data: { id, ...p.value, createdBy: actor } });
    await appendAudit(tx, { actor, action: 'tat-target.add', entityType: 'tat_target', entityId: id, after: p.value });
  });
  return id;
}

export async function retireTatTarget(db: Db, actor: string, id: string, reason: string): Promise<void> {
  if (reason.trim().length < 5) throw new InvalidInput(['Give a reason of at least 5 characters.']);
  await db.$transaction(async (tx) => {
    const n = await tx.tatTarget.updateMany({ where: { id, active: true }, data: { active: false, retiredBy: actor, retiredAt: new Date(), retireReason: reason.trim() } });
    if (n.count !== 1) throw new WorkflowRejected({ code: 'INVALID_STATE', detail: 'that target is not active' });
    await appendAudit(tx, { actor, action: 'tat-target.retire', entityType: 'tat_target', entityId: id, reason: reason.trim() });
  });
}

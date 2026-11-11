import { uuidv7, type Db } from '@lis/db';
import { fromZonedLocal, parseTatTarget, targetFor, zonedDay, type TatTarget, type TatTargetInput } from '@lis/domain';
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
  { key: 'collected_released', from: 'collected', to: 'released', label: 'Specimen to report (collected to released)' },
  { key: 'ordered_released', from: 'ordered', to: 'released', label: 'Order to report (ordered to released)' },
] as const;

/** Who did a step, for the staff filter and grouping. */
export const TAT_ROLES = [
  { key: 'collectedBy', label: 'collected' },
  { key: 'receivedBy', label: 'received' },
  { key: 'enteredBy', label: 'entered the result' },
  { key: 'approvedBy', label: 'approved' },
  { key: 'releasedBy', label: 'released' },
] as const;
export type TatRole = (typeof TAT_ROLES)[number]['key'];

export const TAT_GROUPS = ['test', 'instrument', 'priority', 'day', ...TAT_ROLES.map((r) => r.key)] as const;
export type TatGroup = (typeof TAT_GROUPS)[number];

/** Narrowing within the date range: by test, instrument (or "manual" for results with none) and staff. */
export interface TatNarrow {
  test?: string;
  instrument?: string;
  staff?: string;
  /** Which part the staff member played; any part when left out. */
  role?: TatRole;
}

export function narrowTat(rows: TatResultTimes[], n: TatNarrow): TatResultTimes[] {
  return rows.filter((r) => {
    if (n.test && r.test !== n.test) return false;
    if (n.instrument && (n.instrument === 'manual' ? r.instrumentId !== null : r.instrumentId !== n.instrument)) return false;
    if (n.staff) {
      const roles = n.role ? [n.role] : TAT_ROLES.map((x) => x.key);
      if (!roles.some((k) => r[k] === n.staff)) return false;
    }
    return true;
  });
}

export interface TatFilter {
  from: Date;
  /** Exclusive. */
  to: Date;
  priority: string | null;
  /** The days as entered, in the lab's time zone, both included. */
  fromDay: string;
  toDay: string;
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
  instrumentId: string | null;
  /** Who accessioned the specimen at collection. */
  collectedBy: string | null;
  receivedBy: string | null;
  /** Who made the first value: a person, or system:... for an instrument. */
  enteredBy: string | null;
  releasedBy: string | null;
  /** Changed after approval by a correction. */
  corrected: boolean;
}

/** Calendar arithmetic on "YYYY-MM-DD", independent of any time zone. */
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/**
 * Parse the report's date range: YYYY-MM-DD days in the lab's time zone
 * (A-24), both included, at most 366 days. The default is the last 7 days.
 */
export function parseTatFilter(q: { from?: string | undefined; to?: string | undefined; priority?: string | undefined }, now = new Date(), timeZone = 'UTC'): TatFilter {
  const check = (s: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !fromZonedLocal(s, timeZone)) throw new InvalidInput([`"${s.slice(0, 20)}" is not a date such as 2026-11-04.`]);
    return s;
  };
  const today = zonedDay(now, timeZone);
  const toDay = q.to ? check(q.to) : today;
  const fromDay = q.from ? check(q.from) : addDays(today, -6);
  if (fromDay > toDay) throw new InvalidInput(['The first day must not be after the last day.']);
  if (fromDay < addDays(toDay, -365)) throw new InvalidInput(['Choose at most 366 days.']);
  const priority = q.priority && ['routine', 'urgent', 'stat'].includes(q.priority) ? q.priority : null;
  return { from: fromZonedLocal(fromDay, timeZone) as Date, to: fromZonedLocal(addDays(toDay, 1), timeZone) as Date, priority, fromDay, toDay };
}

/** One row per result whose specimen was collected (or, without a collection time, ordered) in the range. */
export async function tatTimes(db: Db | Tx, f: TatFilter, limit = 50_000): Promise<TatResultTimes[]> {
  return db.$queryRaw<TatResultTimes[]>`
    SELECT s.accession_no AS "accessionNo", COALESCE(t.local_test_code, t.hmis_test_code) AS test, o.priority::text AS priority,
           o.ordered_at AS ordered, s.collected_at AS collected, s.received_at AS received,
           (SELECT min(v.created_at) FROM result_version v WHERE v.result_id = r.id) AS first_value,
           a.at AS approved, a.actor AS "approvedBy",
           rel.at AS released, rel.actor AS "releasedBy",
           EXISTS (SELECT 1 FROM result_event e WHERE e.result_id = r.id AND e.kind = 'correct') AS corrected,
           r.instrument_id AS "instrumentId", s.created_by AS "collectedBy", s.received_by AS "receivedBy",
           (SELECT v.created_by FROM result_version v WHERE v.result_id = r.id ORDER BY v.created_at ASC, v.version_no ASC LIMIT 1) AS "enteredBy",
           (SELECT min(e.at) FROM result_event e WHERE e.result_id = r.id AND e.kind = 'delivery' AND e.detail->>'status' IN ('sent', 'hmis_confirmed')) AS accepted
      FROM result r
      JOIN ordered_test t ON t.id = r.ordered_test_id
      JOIN lab_order o ON o.id = t.order_id
      LEFT JOIN specimen s ON s.id = t.specimen_id
      LEFT JOIN LATERAL (SELECT e.at, e.actor FROM result_event e WHERE e.result_id = r.id AND e.kind = 'approve' ORDER BY e.at ASC LIMIT 1) a ON true
      LEFT JOIN LATERAL (SELECT e.at, e.actor FROM result_event e WHERE e.result_id = r.id AND e.kind = 'release' ORDER BY e.at ASC LIMIT 1) rel ON true
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

/** The key a row is grouped under. */
export function tatGroupKey(r: TatResultTimes, by: TatGroup, timeZone = 'UTC'): string {
  switch (by) {
    case 'test': return r.test;
    case 'instrument': return r.instrumentId ?? 'manual';
    case 'priority': return r.priority;
    case 'day': { const d = r.collected ?? r.ordered; return d ? zonedDay(d, timeZone) : '(no time)'; }
    default: return r[by] ?? '(none)';
  }
}

export function summarizeTat(rows: TatResultTimes[], targets: TatTarget[] = [], now = new Date(), by: TatGroup = 'test', timeZone = 'UTC'): { all: TatRow; tests: TatRow[] } {
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
  const byKey = new Map<string, TatResultTimes[]>();
  for (const r of rows) {
    const k = tatGroupKey(r, by, timeZone);
    const list = byKey.get(k);
    if (list) list.push(r);
    else byKey.set(k, [r]);
  }
  return { all: group('All', rows), tests: [...byKey.keys()].sort().map((t) => group(t, byKey.get(t)!)) };
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

export interface LabKpis {
  results: number;
  released: number;
  /** Released (or open) against a receipt-to-release target. */
  target: TatTargetCount;
  autoverified: number;
  corrected: number;
  specimens: number;
  rejected: number;
  /** Most common rejection reasons, by the coded part before any ":". */
  rejectionReasons: { reason: string; n: number }[];
  critical: number;
  criticalCalled: number;
  /** Seconds from the first critical value to the first call. */
  criticalCallMedian: number | null;
  criticalCallP90: number | null;
  overdueNow: number;
  sendOuts: { sent: number; onTime: number; late: number; overdue: number; awaiting: number };
}

/**
 * Other indicators for the same days (A-22): specimen rejection, autoverified
 * and corrected results, critical results and how fast they were called, and
 * send-outs against their agreed turnaround. Results-based figures follow the
 * narrowed rows; specimen, critical and send-out figures follow the days and
 * priority only.
 */
export async function labKpis(db: Db | Tx, f: TatFilter, rows: TatResultTimes[], targets: TatTarget[], now = new Date()): Promise<LabKpis> {
  const s = summarizeTat(rows, targets, now);
  const specimens = await db.$queryRaw<{ status: string; reason: string | null }[]>`
    SELECT s.status, s.rejection_reason AS reason FROM specimen s JOIN lab_order o ON o.id = s.order_id
     WHERE COALESCE(s.collected_at, s.created_at) >= ${f.from} AND COALESCE(s.collected_at, s.created_at) < ${f.to}
       AND (${f.priority}::text IS NULL OR o.priority::text = ${f.priority})`;
  const reasons = new Map<string, number>();
  for (const x of specimens) if (x.status === 'rejected') {
    const k = (x.reason ?? '(no reason)').split(':')[0]!.trim().slice(0, 60) || '(no reason)';
    reasons.set(k, (reasons.get(k) ?? 0) + 1);
  }
  const crit = await db.$queryRaw<{ first: Date; called: Date | null }[]>`
    SELECT min(v.created_at) AS first, (SELECT min(c.called_at) FROM critical_call c WHERE c.result_id = r.id) AS called
      FROM result r
      JOIN result_version v ON v.result_id = r.id AND v.critical_flag IS NOT NULL
      JOIN ordered_test t ON t.id = r.ordered_test_id
      JOIN lab_order o ON o.id = t.order_id
      LEFT JOIN specimen s ON s.id = t.specimen_id
     WHERE COALESCE(s.collected_at, o.ordered_at) >= ${f.from} AND COALESCE(s.collected_at, o.ordered_at) < ${f.to}
       AND (${f.priority}::text IS NULL OR o.priority::text = ${f.priority})
     GROUP BY r.id`;
  const delays = crit.filter((c) => c.called && c.called >= c.first).map((c) => (c.called!.getTime() - c.first.getTime()) / 1000).sort((a, b) => a - b);
  const sent = await db.sendOutTest.findMany({
    where: { sendOut: { dispatchedAt: { gte: f.from, lt: f.to } }, active: true, ...(f.priority ? { orderedTest: { order: { priority: f.priority } } } : {}) },
    include: { sendOut: true, orderedTest: { include: { result: { include: { events: { where: { kind: 'enter' }, orderBy: { at: 'asc' }, take: 1 } } } } } },
  });
  const so = { sent: sent.length, onTime: 0, late: 0, overdue: 0, awaiting: 0 };
  for (const x of sent) {
    const due = x.sendOut.dispatchedAt.getTime() + x.tatHours * 3_600_000;
    const at = x.orderedTest.result?.events[0]?.at;
    if (at && at.getTime() <= due) so.onTime++;
    else if (at) so.late++;
    else if (now.getTime() > due) so.overdue++;
    else so.awaiting++;
  }
  return {
    results: rows.length,
    released: rows.filter((r) => r.released).length,
    target: s.all.target,
    autoverified: rows.filter((r) => r.approvedBy === 'system:autoverify').length,
    corrected: rows.filter((r) => r.corrected).length,
    specimens: specimens.length,
    rejected: specimens.filter((x) => x.status === 'rejected').length,
    rejectionReasons: [...reasons.entries()].map(([reason, n]) => ({ reason, n })).sort((a, b) => b.n - a.n || a.reason.localeCompare(b.reason)).slice(0, 5),
    critical: crit.length,
    criticalCalled: crit.filter((c) => c.called).length,
    criticalCallMedian: percentile(delays, 0.5),
    criticalCallP90: percentile(delays, 0.9),
    overdueNow: (await overdueResults(db, now)).length,
    sendOuts: so,
  };
}

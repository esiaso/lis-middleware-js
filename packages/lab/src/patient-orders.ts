import type { Db } from '@lis/db';
import { APPROVED_STATUSES } from './history.js';
import type { Tx } from './tx.js';

/**
 * Which patients are waiting for results, and each patient's orders with how
 * far their tests have got (09 W-13). A test is pending while it is not
 * cancelled (or moved by reconciliation) and has no approved result.
 */

const PRIORITY_RANK: Record<string, number> = { stat: 0, urgent: 1, routine: 2 };
const OPEN_ORDER = { status: { notIn: ['cancelled', 'reconciled'] } };
const PENDING_TEST = { status: { notIn: ['cancelled', 'reconciled'] }, OR: [{ result: null }, { result: { status: { notIn: APPROVED_STATUSES } } }] };

export interface PendingPatient {
  patientId: string;
  /** Tests on open orders with no approved result yet. */
  pendingTests: number;
  orders: number;
  /** The most urgent priority among those orders. */
  priority: string;
  /** When the oldest of those orders was placed. */
  oldestOrderedAt: Date;
}

/** Patients with results still pending, most urgent first, then longest waiting. At most `cap` pending tests are read. */
export async function patientsWithPendingResults(db: Db | Tx, opts: { search?: string; cap?: number } = {}): Promise<{ rows: PendingPatient[]; capped: boolean }> {
  const cap = opts.cap ?? 5000;
  const q = (opts.search ?? '').trim();
  const tests = await db.orderedTest.findMany({
    where: {
      ...PENDING_TEST,
      order: {
        ...OPEN_ORDER,
        ...(q ? { patient: { OR: [{ mrn: { startsWith: q, mode: 'insensitive' as const } }, { familyName: { startsWith: q, mode: 'insensitive' as const } }, { givenName: { startsWith: q, mode: 'insensitive' as const } }] } } : {}),
      },
    },
    select: { orderId: true, order: { select: { patientId: true, priority: true, orderedAt: true } } },
    take: cap + 1,
  });
  const capped = tests.length > cap;
  const by = new Map<string, PendingPatient & { orderIds: Set<string> }>();
  for (const t of tests.slice(0, cap)) {
    const o = t.order;
    let p = by.get(o.patientId);
    if (!p) {
      p = { patientId: o.patientId, pendingTests: 0, orders: 0, priority: o.priority, oldestOrderedAt: o.orderedAt, orderIds: new Set() };
      by.set(o.patientId, p);
    }
    p.pendingTests++;
    p.orderIds.add(t.orderId);
    if ((PRIORITY_RANK[o.priority] ?? 3) < (PRIORITY_RANK[p.priority] ?? 3)) p.priority = o.priority;
    if (o.orderedAt < p.oldestOrderedAt) p.oldestOrderedAt = o.orderedAt;
  }
  const rows = [...by.values()].map(({ orderIds, ...p }) => ({ ...p, orders: orderIds.size }));
  rows.sort((a, b) => (PRIORITY_RANK[a.priority] ?? 3) - (PRIORITY_RANK[b.priority] ?? 3) || a.oldestOrderedAt.getTime() - b.oldestOrderedAt.getTime() || a.patientId.localeCompare(b.patientId));
  return { rows, capped };
}

export interface PatientOrder {
  id: string;
  hmisOrderId: string;
  mrn: string;
  priority: string;
  status: string;
  source: string;
  location: string | null;
  orderedAt: Date;
  tests: { code: string; state: 'approved' | 'pending' | 'cancelled' }[];
  approved: number;
  pending: number;
  /** Has a test still waiting for an approved result. */
  current: boolean;
}

/** Orders of these patients (a patient and any MRNs merged into it), newest first. */
export async function patientOrders(db: Db | Tx, patientIds: string[], take = 200): Promise<PatientOrder[]> {
  const orders = await db.labOrder.findMany({
    where: { patientId: { in: patientIds } },
    orderBy: [{ orderedAt: 'desc' }, { id: 'desc' }],
    take,
    include: { patient: { select: { mrn: true } }, tests: { orderBy: { hmisLineId: 'asc' }, select: { localTestCode: true, hmisTestCode: true, status: true, result: { select: { status: true } } } } },
  });
  return orders.map((o) => {
    const open = o.status !== 'cancelled' && o.status !== 'reconciled';
    const tests = o.tests.map((t) => ({
      code: t.localTestCode ?? t.hmisTestCode,
      state: (t.status === 'cancelled' || t.status === 'reconciled' || !open ? (t.result && APPROVED_STATUSES.includes(t.result.status) ? 'approved' : 'cancelled') : t.result && APPROVED_STATUSES.includes(t.result.status) ? 'approved' : 'pending') as 'approved' | 'pending' | 'cancelled',
    }));
    const pending = tests.filter((t) => t.state === 'pending').length;
    return {
      id: o.id,
      hmisOrderId: o.hmisOrderId,
      mrn: o.patient.mrn,
      priority: o.priority,
      status: o.status,
      source: o.source,
      location: o.location,
      orderedAt: o.orderedAt,
      tests,
      approved: tests.filter((t) => t.state === 'approved').length,
      pending,
      current: pending > 0,
    };
  });
}

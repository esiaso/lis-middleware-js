import type { ResultValue } from '@lis/contracts';
import type { Db } from '@lis/db';
import { APPROVED_STATUSES } from './history.js';
import type { Tx } from './tx.js';

/**
 * The printed result report for one order (09 W-14). Only approved results
 * carry a value; anything else is "pending", so a value nobody has approved
 * can never leave the lab on paper. The reference range is the text the
 * instrument sent with the value, when it sent one; the middleware has no
 * reference ranges of its own.
 */
export interface ReportLine {
  resultId: string | null;
  test: string;
  hmisTestCode: string;
  specimen: string | null;
  state: 'approved' | 'pending' | 'cancelled';
  value: ResultValue | null;
  units: string | null;
  abnormalFlags: string[];
  critical: string | null;
  corrected: boolean;
  referenceRange: string | null;
  approvedBy: string | null;
  approvedAt: Date | null;
}

export async function orderReport(db: Db | Tx, orderId: string): Promise<ReportLine[]> {
  const tests = await db.orderedTest.findMany({
    where: { orderId },
    orderBy: { hmisLineId: 'asc' },
    include: { specimen: { select: { accessionNo: true } }, result: { include: { versions: true, events: { where: { kind: { in: ['approve', 'correct'] } }, orderBy: { at: 'desc' }, take: 1 } } } },
  });
  const lines: ReportLine[] = [];
  for (const t of tests) {
    const r = t.result;
    const v = r?.versions.find((x) => x.versionNo === r.selectedVersionNo);
    const approved = !!r && !!v && APPROVED_STATUSES.includes(r.status);
    let referenceRange: string | null = null;
    if (approved && v!.observationId) {
      const o = await db.observation.findUnique({ where: { id: v!.observationId }, select: { seq: true, normalizedMessage: { select: { payload: true } } } });
      const payload = o?.normalizedMessage.payload as { observations?: { referenceRangeText?: string }[] } | undefined;
      referenceRange = payload?.observations?.[o!.seq - 1]?.referenceRangeText?.trim() || null;
    }
    const event = r?.events[0];
    lines.push({
      resultId: r?.id ?? null,
      test: t.localTestCode ?? t.hmisTestCode,
      hmisTestCode: t.hmisTestCode,
      specimen: t.specimen?.accessionNo ?? null,
      state: t.status === 'cancelled' ? 'cancelled' : approved ? 'approved' : 'pending',
      value: approved ? (v!.value as unknown as ResultValue) : null,
      units: approved ? v!.units : null,
      abnormalFlags: approved ? v!.abnormalFlags : [],
      critical: approved && (v!.criticalFlag === 'LOW' || v!.criticalFlag === 'HIGH') ? v!.criticalFlag : null,
      corrected: approved && v!.kind === 'correction',
      referenceRange,
      approvedBy: approved ? (event?.actor ?? r!.approvedBy) : null,
      approvedAt: approved ? (event?.at ?? null) : null,
    });
  }
  return lines;
}

import type { ResultValue } from '@lis/contracts';
import type { Db } from '@lis/db';
import { APPROVED_STATUSES } from './history.js';
import { reportComments } from './comments.js';
import { instrumentReferenceText, labReferences, type ReferenceShown } from './reference-ranges.js';
import type { Tx } from './tx.js';

/**
 * The printed result report for one order (09 W-14). Only approved results
 * carry a value; anything else is "pending", so a value nobody has approved
 * can never leave the lab on paper. The reference range is the lab's own
 * (A-25) when one applies to the patient, otherwise the text the instrument
 * sent with the value, when it sent one.
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
  /** The instrument's text; shown only when the lab has no range for this patient. */
  referenceRange: string | null;
  labReference: ReferenceShown | null;
  /** Comments marked for the report (A-26), on approved lines only. */
  comments: string[];
  approvedBy: string | null;
  approvedAt: Date | null;
}

export async function orderReport(db: Db | Tx, orderId: string): Promise<ReportLine[]> {
  const tests = await db.orderedTest.findMany({
    where: { orderId },
    orderBy: { hmisLineId: 'asc' },
    include: { order: { select: { patient: { select: { sex: true, birthDate: true } } } }, specimen: { select: { accessionNo: true, collectedAt: true } }, result: { include: { versions: true, events: { where: { kind: { in: ['approve', 'correct'] } }, orderBy: { at: 'desc' }, take: 1 } } } },
  });
  const lines: ReportLine[] = [];
  for (const t of tests) {
    const r = t.result;
    const v = r?.versions.find((x) => x.versionNo === r.selectedVersionNo);
    const approved = !!r && !!v && APPROVED_STATUSES.includes(r.status);
    const referenceRange = approved ? await instrumentReferenceText(db, v!.observationId) : null;
    const [labReference] = approved
      ? await labReferences(db, [{ localTestCode: t.localTestCode, sex: t.order.patient.sex, birthDate: t.order.patient.birthDate, collectedAt: t.specimen?.collectedAt ?? null, storedAt: v!.createdAt, value: v!.value as unknown as ResultValue, units: v!.units }])
      : [null];
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
      labReference: labReference ?? null,
      comments: [],
      approvedBy: approved ? (event?.actor ?? r!.approvedBy) : null,
      approvedAt: approved ? (event?.at ?? null) : null,
    });
  }
  const comments = await reportComments(db, lines.filter((l) => l.state === 'approved' && l.resultId).map((l) => l.resultId as string));
  for (const l of lines) if (l.resultId && l.state === 'approved') l.comments = comments.get(l.resultId) ?? [];
  return lines;
}

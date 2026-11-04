import { uuidv7, type Db } from '@lis/db';
import type { Tx } from './tx.js';
import { appendAudit } from './audit.js';
import { WorkflowRejected } from './results.js';

/**
 * Accession a specimen for some ordered tests at collection (W-2/W-3).
 * Accession number: L + YYMMDD + 5-digit daily sequence, never reused
 * (06 §5). The barcode equals the accession number (B-8 may change this).
 */
export async function accessionSpecimen(
  db: Db,
  input: { orderId: string; orderedTestIds: string[]; user: string; collectedAt?: Date; now?: Date },
): Promise<{ specimenId: string; accessionNo: string }> {
  const now = input.now ?? new Date();
  const day = now.toISOString().slice(2, 10).replace(/-/g, '');
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(724102)`;
    const prefix = `L${day}`;
    const last = await tx.specimen.findFirst({ where: { accessionNo: { startsWith: prefix } }, orderBy: { accessionNo: 'desc' } });
    const seq = last ? Number(last.accessionNo.slice(prefix.length)) + 1 : 1;
    const accessionNo = `${prefix}${String(seq).padStart(5, '0')}`;
    const tests = await tx.orderedTest.findMany({ where: { id: { in: input.orderedTestIds }, orderId: input.orderId } });
    if (input.orderedTestIds.length === 0) throw new WorkflowRejected({ code: 'INVALID_STATE', detail: 'choose at least one test to collect' });
    if (tests.length !== input.orderedTestIds.length) throw new WorkflowRejected({ code: 'INVALID_STATE', detail: 'some tests do not belong to this order' });
    if (tests.some((t) => t.specimenId)) throw new WorkflowRejected({ code: 'INVALID_STATE', detail: 'a test already has a specimen; reload the order' });
    if (tests.some((t) => t.status === 'cancelled')) throw new WorkflowRejected({ code: 'INVALID_STATE', detail: 'a cancelled test cannot be collected' });
    if (new Set(tests.map((t) => t.specimenType).filter(Boolean)).size > 1) throw new WorkflowRejected({ code: 'INVALID_STATE', detail: 'tests needing different specimen types go in separate containers; collect them separately' });
    const specimenId = uuidv7();
    await tx.specimen.create({
      data: { id: specimenId, orderId: input.orderId, accessionNo, barcode: accessionNo, status: 'collected', collectedAt: input.collectedAt ?? now, createdBy: input.user, labelPrints: 1 },
    });
    await tx.orderedTest.updateMany({ where: { id: { in: input.orderedTestIds } }, data: { specimenId } });
    await appendAudit(tx, { actor: input.user, action: 'specimen.collected', entityType: 'specimen', entityId: specimenId, after: { accessionNo, tests: input.orderedTestIds.length } });
    return { specimenId, accessionNo };
  });
}

/** Coded rejection reasons (W-2). "other" needs the free text to say what. */
export const REJECTION_REASONS = {
  haemolysed: 'Haemolysed',
  clotted: 'Clotted',
  insufficient: 'Insufficient volume',
  'wrong-container': 'Wrong container',
  'label-problem': 'Unlabelled or mislabelled',
  'transport-delay': 'Transport delay or wrong temperature',
  other: 'Other',
} as const;
export type RejectionReason = keyof typeof REJECTION_REASONS;

async function loadSpecimen(tx: Tx, specimenId: string) {
  const sp = await tx.specimen.findUnique({ where: { id: specimenId } });
  if (!sp) throw new WorkflowRejected({ code: 'INVALID_STATE', detail: 'specimen not found' });
  return sp;
}

/** Received in the lab (W-3). Only a collected specimen can be received. */
export async function receiveSpecimen(db: Db, specimenId: string, user: string, now = new Date()): Promise<void> {
  await db.$transaction(async (tx) => {
    const n = await tx.specimen.updateMany({ where: { id: specimenId, status: 'collected' }, data: { status: 'received', receivedAt: now, receivedBy: user } });
    if (n.count !== 1) {
      const sp = await loadSpecimen(tx, specimenId);
      throw new WorkflowRejected({ code: 'INVALID_STATE', detail: `the specimen is ${sp.status}, not waiting to be received` });
    }
    await appendAudit(tx, { actor: user, action: 'specimen.received', entityType: 'specimen', entityId: specimenId });
  });
}

/** Count a (re)print and audit it (W-2: "reprinting creates an audit event and shows the reprint count"). */
export async function recordLabelPrint(db: Db, specimenId: string, user: string): Promise<number> {
  return db.$transaction(async (tx) => {
    await loadSpecimen(tx, specimenId);
    const sp = await tx.specimen.update({ where: { id: specimenId }, data: { labelPrints: { increment: 1 } } });
    await appendAudit(tx, { actor: user, action: 'specimen.label-reprint', entityType: 'specimen', entityId: specimenId, after: { labelPrints: sp.labelPrints } });
    return sp.labelPrints;
  });
}

/**
 * Reject a specimen with a coded reason and free text (W-2). Results that
 * still arrive for its barcode go to the unmatched list as REJECTED_SPECIMEN.
 * With `recollect`, its tests that have no result yet are released so a new
 * specimen can be collected for them.
 */
export async function rejectSpecimen(
  db: Db,
  specimenId: string,
  user: string,
  input: { code: RejectionReason; text: string; recollect: boolean },
): Promise<{ released: number }> {
  const text = input.text.trim();
  if (!(input.code in REJECTION_REASONS)) throw new WorkflowRejected({ code: 'REASON_REQUIRED', detail: 'choose a rejection reason' });
  if (text.length < 5) throw new WorkflowRejected({ code: 'REASON_REQUIRED', detail: 'describe the problem (at least 5 characters)' });
  return db.$transaction(async (tx) => {
    const sp = await loadSpecimen(tx, specimenId);
    if (sp.status !== 'collected' && sp.status !== 'received') throw new WorkflowRejected({ code: 'INVALID_STATE', detail: `the specimen is already ${sp.status}` });
    const reason = `${input.code}: ${text}`;
    await tx.specimen.update({ where: { id: specimenId }, data: { status: 'rejected', rejectionReason: reason } });
    let released = 0;
    if (input.recollect) {
      const r = await tx.orderedTest.updateMany({ where: { specimenId, result: null }, data: { specimenId: null } });
      released = r.count;
    }
    await appendAudit(tx, { actor: user, action: 'specimen.rejected', entityType: 'specimen', entityId: specimenId, reason, after: { recollect: input.recollect, released } });
    return { released };
  });
}

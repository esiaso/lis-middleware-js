import { uuidv7, type Db } from '@lis/db';
import { appendAudit } from './audit.js';

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
    if (tests.length !== input.orderedTestIds.length) throw new Error('some tests do not belong to this order');
    if (tests.some((t) => t.specimenId)) throw new Error('a test already has a specimen');
    const specimenId = uuidv7();
    await tx.specimen.create({
      data: { id: specimenId, orderId: input.orderId, accessionNo, barcode: accessionNo, status: 'collected', collectedAt: input.collectedAt ?? now, createdBy: input.user },
    });
    await tx.orderedTest.updateMany({ where: { id: { in: input.orderedTestIds } }, data: { specimenId } });
    await appendAudit(tx, { actor: input.user, action: 'specimen.collected', entityType: 'specimen', entityId: specimenId, after: { accessionNo, tests: input.orderedTestIds.length } });
    return { specimenId, accessionNo };
  });
}

export async function rejectSpecimen(db: Db, specimenId: string, user: string, reason: string): Promise<void> {
  if (reason.trim().length < 5) throw new Error('a rejection needs a reason');
  await db.$transaction(async (tx) => {
    await tx.specimen.update({ where: { id: specimenId }, data: { status: 'rejected' } });
    await appendAudit(tx, { actor: user, action: 'specimen.rejected', entityType: 'specimen', entityId: specimenId, reason });
  });
}

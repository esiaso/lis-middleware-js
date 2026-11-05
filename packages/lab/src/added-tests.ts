import type { Db } from '@lis/db';
import { appendAudit } from './audit.js';
import { WorkflowRejected } from './results.js';
import type { Tx } from './tx.js';

/**
 * Tests the lab added to an HMIS order from an unmatched result (A-34). The
 * result is held from the HMIS until the clinician's order line arrives on
 * the next poll; a person then matches the added test to that line, which
 * moves the specimen and result onto it. Nothing is matched automatically:
 * the clinician may have ordered the test again for a new sample.
 */

const reject = (detail: string) => new WorkflowRejected({ code: 'INVALID_STATE', detail });

/** HMIS tests on the same order that an added test could move to: same local test, active, no specimen and no result. */
export async function matchCandidates(db: Db | Tx, addedTestId: string) {
  const added = await db.orderedTest.findUnique({ where: { id: addedTestId } });
  if (!added || added.source !== 'LAB_ADDED' || added.status !== 'active') return [];
  return db.orderedTest.findMany({
    where: { orderId: added.orderId, source: 'HMIS', status: 'active', localTestCode: added.localTestCode, specimenId: null, result: null },
    orderBy: { hmisLineId: 'asc' },
  });
}

export async function matchAddedTest(db: Db, addedTestId: string, hmisTestId: string, user: string): Promise<void> {
  await db.$transaction(async (tx) => {
    const added = await tx.orderedTest.findUnique({ where: { id: addedTestId }, include: { result: true, order: true } });
    if (!added || added.source !== 'LAB_ADDED') throw reject('not a test added by the lab');
    if (added.status !== 'active') throw reject(`already ${added.status}${added.matchedBy ? ` by ${added.matchedBy}` : ''}`);
    const to = await tx.orderedTest.findUnique({ where: { id: hmisTestId }, include: { result: true } });
    if (!to || to.orderId !== added.orderId || to.source !== 'HMIS') throw reject('choose an HMIS line on the same order');
    if (to.localTestCode !== added.localTestCode) throw reject(`that line is ${to.localTestCode ?? to.hmisTestCode}, not ${added.localTestCode}`);
    if (to.status !== 'active') throw reject(`that line is ${to.status}`);
    if (to.specimenId || to.result) throw reject('that line already has a specimen or a result');
    const now = new Date();
    // Free the added test first: a specimen link and a result belong to one test at a time.
    await tx.orderedTest.update({ where: { id: added.id }, data: { specimenId: null, status: 'reconciled', matchedToId: to.id, matchedBy: user, matchedAt: now } });
    await tx.orderedTest.update({ where: { id: to.id }, data: { specimenId: added.specimenId } });
    if (added.result) await tx.result.update({ where: { id: added.result.id }, data: { orderedTestId: to.id } });
    await appendAudit(tx, {
      actor: user, action: 'order.added-test-matched', entityType: 'lab_order', entityId: added.orderId,
      after: { hmisOrderId: added.order.hmisOrderId, localTestCode: added.localTestCode, from: added.id, to: to.id, hmisLineId: to.hmisLineId, resultId: added.result?.id ?? null },
    });
  });
}

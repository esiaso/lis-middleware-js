import type { Db } from '@lis/db';
import { appendAudit } from './audit.js';
import { attachObservation } from './matching.js';
import { WorkflowRejected } from './results.js';
import type { Tx } from './tx.js';

/**
 * Close an unmatched observation without attaching it to a patient
 * (for example a calibrator run under a patient rack, or a duplicate that
 * was re-run under the right barcode). Attaching an unmatched observation to
 * a specimen goes through proposeLink and confirmLink below.
 */
export async function dismissUnmatched(db: Db, unmatchedId: string, user: string, reason: string): Promise<void> {
  const why = reason.trim();
  if (why.length < 5) throw new WorkflowRejected({ code: 'REASON_REQUIRED', detail: 'give a reason of at least 5 characters' });
  await db.$transaction(async (tx) => {
    const n = await tx.unmatchedResult.updateMany({
      where: { id: unmatchedId, resolvedAt: null },
      data: { resolvedAt: new Date(), resolvedBy: user, resolution: `dismissed: ${why}` },
    });
    if (n.count !== 1) throw new WorkflowRejected({ code: 'INVALID_STATE', detail: 'already resolved or not found' });
    await appendAudit(tx, { actor: user, action: 'unmatched.dismiss', entityType: 'unmatched_result', entityId: unmatchedId, reason: why });
  });
}

const reject = (code: 'INVALID_STATE' | 'SAME_PERSON' | 'REASON_REQUIRED', detail: string) => new WorkflowRejected({ code, detail });

/** Where a proposed link would put the observation, checked again at confirmation. */
async function linkTarget(tx: Tx, unmatchedId: string, target: { accessionNo: string } | { testId: string }) {
  const u = await tx.unmatchedResult.findUnique({ where: { id: unmatchedId } });
  if (!u || u.resolvedAt) throw reject('INVALID_STATE', 'already resolved or not found');
  const o = await tx.observation.findUniqueOrThrow({ where: { id: u.observationId }, include: { normalizedMessage: true } });
  // An unmapped code has no checked meaning or units yet: fix the mapping, never guess it here.
  if (o.mapping !== 'MAPPED' || !o.localTestCode) throw reject('INVALID_STATE', `instrument code ${o.instrumentTestCode} has no active mapping; fix the test mapping first`);
  const specimen =
    'accessionNo' in target
      ? await tx.specimen.findUnique({ where: { accessionNo: target.accessionNo.trim().toUpperCase() }, include: { tests: true, order: true } })
      : await tx.specimen.findFirst({ where: { tests: { some: { id: target.testId } } }, include: { tests: true, order: true } });
  if (!specimen) throw reject('INVALID_STATE', 'no specimen with that accession number');
  if (specimen.status === 'rejected') throw reject('INVALID_STATE', `specimen ${specimen.accessionNo} was rejected`);
  if (specimen.order.status === 'cancelled') throw reject('INVALID_STATE', `order ${specimen.order.hmisOrderId} is cancelled`);
  const test = specimen.tests.find((t) => ('testId' in target ? t.id === target.testId : t.localTestCode === o.localTestCode));
  if (!test || test.localTestCode !== o.localTestCode) throw reject('INVALID_STATE', `specimen ${specimen.accessionNo} has no ${o.localTestCode} ordered`);
  if (test.status === 'cancelled') throw reject('INVALID_STATE', `${o.localTestCode} on ${specimen.accessionNo} is cancelled`);
  return { u, o, specimen, test };
}

/**
 * First person: propose attaching an unmatched observation to the same test
 * on a specimen (for example a misread or hand-relabelled barcode). Nothing
 * reaches a patient until a different person confirms (10 §2).
 */
export async function proposeLink(db: Db, unmatchedId: string, user: string, input: { accessionNo: string; reason: string }): Promise<void> {
  const why = input.reason.trim();
  if (why.length < 10) throw reject('REASON_REQUIRED', 'say why this result belongs to that specimen (at least 10 characters)');
  await db.$transaction(async (tx) => {
    const { u, specimen, test } = await linkTarget(tx, unmatchedId, { accessionNo: input.accessionNo });
    if (u.proposedBy) throw reject('INVALID_STATE', `${u.proposedBy} has already proposed a link; confirm or withdraw it first`);
    const n = await tx.unmatchedResult.updateMany({
      where: { id: unmatchedId, resolvedAt: null, proposedBy: null },
      data: { proposedTestId: test.id, proposedBy: user, proposedAt: new Date(), proposalReason: why },
    });
    if (n.count !== 1) throw reject('INVALID_STATE', 'changed by someone else; reload');
    await appendAudit(tx, { actor: user, action: 'unmatched.link-proposed', entityType: 'unmatched_result', entityId: unmatchedId, reason: why, after: { accessionNo: specimen.accessionNo, orderedTestId: test.id } });
  });
}

/** Take back a proposal (anyone allowed to resolve may do this). */
export async function withdrawLink(db: Db, unmatchedId: string, user: string): Promise<void> {
  await db.$transaction(async (tx) => {
    const u = await tx.unmatchedResult.findUnique({ where: { id: unmatchedId } });
    if (!u || u.resolvedAt || !u.proposedBy) throw reject('INVALID_STATE', 'no open proposal');
    await tx.unmatchedResult.update({ where: { id: unmatchedId }, data: { proposedTestId: null, proposedBy: null, proposedAt: null, proposalReason: null } });
    await appendAudit(tx, { actor: user, action: 'unmatched.link-withdrawn', entityType: 'unmatched_result', entityId: unmatchedId, before: { proposedBy: u.proposedBy, orderedTestId: u.proposedTestId } });
  });
}

/**
 * Second person: confirm the proposal. The observation becomes a result
 * version on that test, which then goes through review and approval as usual.
 */
export async function confirmLink(db: Db, unmatchedId: string, user: string): Promise<{ resultId: string }> {
  return db.$transaction(async (tx) => {
    const u0 = await tx.unmatchedResult.findUnique({ where: { id: unmatchedId } });
    if (!u0 || u0.resolvedAt || !u0.proposedBy || !u0.proposedTestId) throw reject('INVALID_STATE', 'no open proposal to confirm');
    if (u0.proposedBy === user) throw reject('SAME_PERSON', 'a different person must confirm the link');
    const { o, specimen, test } = await linkTarget(tx, unmatchedId, { testId: u0.proposedTestId });
    const resolution = `linked to ${specimen.accessionNo} ${test.localTestCode}: proposed by ${u0.proposedBy} (${u0.proposalReason ?? ''}), confirmed by ${user}`;
    const n = await tx.unmatchedResult.updateMany({
      where: { id: unmatchedId, resolvedAt: null, proposedBy: u0.proposedBy, proposedTestId: u0.proposedTestId },
      data: { resolvedAt: new Date(), resolvedBy: user, resolution },
    });
    if (n.count !== 1) throw reject('INVALID_STATE', 'changed by someone else; reload');
    const resultId = await attachObservation(tx, o.normalizedMessage, o, test);
    await tx.unmatchedResult.update({ where: { id: unmatchedId }, data: { linkedResultId: resultId } });
    await appendAudit(tx, { actor: user, action: 'unmatched.link-confirmed', entityType: 'unmatched_result', entityId: unmatchedId, reason: u0.proposalReason ?? '', after: { accessionNo: specimen.accessionNo, orderedTestId: test.id, resultId, proposedBy: u0.proposedBy } });
    await appendAudit(tx, { actor: user, action: 'specimen.result-linked', entityType: 'specimen', entityId: specimen.id, reason: `${test.localTestCode} from unmatched ${o.normalizedMessage.instrumentId} sample ${o.normalizedMessage.sampleId ?? '(none)'}, proposed by ${u0.proposedBy}`, after: { unmatchedId, resultId } });
    return { resultId };
  });
}

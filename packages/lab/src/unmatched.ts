import { uuidv7, type Db } from '@lis/db';
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
      data: { proposedAction: 'LINK', proposedTestId: test.id, proposedBy: user, proposedAt: new Date(), proposalReason: why },
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
    await tx.unmatchedResult.update({
      where: { id: unmatchedId },
      data: { proposedAction: null, proposedTestId: null, proposedSpecimenId: null, proposedRequestedBy: null, proposedBy: null, proposedAt: null, proposalReason: null },
    });
    await appendAudit(tx, {
      actor: user, action: 'unmatched.link-withdrawn', entityType: 'unmatched_result', entityId: unmatchedId,
      before: { action: u.proposedAction, proposedBy: u.proposedBy, orderedTestId: u.proposedTestId, specimenId: u.proposedSpecimenId },
    });
  });
}

/**
 * Second person: confirm the proposal. The observation becomes a result
 * version on that test, which then goes through review and approval as usual.
 */
export async function confirmLink(db: Db, unmatchedId: string, user: string): Promise<{ resultId: string }> {
  return db.$transaction(async (tx) => {
    const u0 = await tx.unmatchedResult.findUnique({ where: { id: unmatchedId } });
    if (!u0 || u0.resolvedAt || !u0.proposedBy) throw reject('INVALID_STATE', 'no open proposal to confirm');
    if (u0.proposedBy === user) throw reject('SAME_PERSON', 'a different person must confirm the link');
    if (u0.proposedAction === 'ADD_TEST') return confirmAddTest(tx, u0, user);
    if (!u0.proposedTestId) throw reject('INVALID_STATE', 'no open proposal to confirm');
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

/**
 * Where an added test would go: a specimen whose order is from the HMIS and
 * does not already have this test (A-34). Checked again at confirmation.
 */
async function addTarget(tx: Tx, unmatchedId: string, target: { accessionNo: string } | { specimenId: string }) {
  const u = await tx.unmatchedResult.findUnique({ where: { id: unmatchedId } });
  if (!u || u.resolvedAt) throw reject('INVALID_STATE', 'already resolved or not found');
  // Only for the tube the instrument read: a misread or unknown barcode is linked, never added.
  if (u.reason !== 'NOT_ORDERED') throw reject('INVALID_STATE', 'a test can be added only when the instrument read a known barcode and the test was not ordered');
  const o = await tx.observation.findUniqueOrThrow({ where: { id: u.observationId }, include: { normalizedMessage: true } });
  if (o.mapping !== 'MAPPED' || !o.localTestCode) throw reject('INVALID_STATE', `instrument code ${o.instrumentTestCode} has no active mapping; fix the test mapping first`);
  const where = 'accessionNo' in target ? { accessionNo: target.accessionNo.trim().toUpperCase() } : { id: target.specimenId };
  const specimen = await tx.specimen.findUnique({ where, include: { order: { include: { tests: true } } } });
  if (!specimen) throw reject('INVALID_STATE', 'no specimen with that accession number');
  if (!specimen.barcodeActive || specimen.barcode !== o.normalizedMessage.sampleId) {
    throw reject('INVALID_STATE', `${specimen.accessionNo} is not the tube the instrument read (${o.normalizedMessage.sampleId ?? 'no barcode'}); scan that tube`);
  }
  if (specimen.status === 'rejected') throw reject('INVALID_STATE', `specimen ${specimen.accessionNo} was rejected`);
  const order = specimen.order;
  if (order.status !== 'active') throw reject('INVALID_STATE', `order ${order.hmisOrderId} is ${order.status}`);
  if (order.source !== 'HMIS') throw reject('INVALID_STATE', `${order.hmisOrderId} is a downtime order; add the test when registering or reconciling it`);
  const already = order.tests.find((t) => t.localTestCode === o.localTestCode && t.status === 'active');
  if (already) {
    throw reject('INVALID_STATE', already.specimenId === specimen.id
      ? `${specimen.accessionNo} already has ${o.localTestCode} ordered; link the result to it instead`
      : `order ${order.hmisOrderId} already has ${o.localTestCode} ordered on another specimen or not yet collected; link the result there, or collect it`);
  }
  return { u, o, specimen, order };
}

/**
 * First person: propose adding the instrument's test to the order of the
 * specimen it ran on, because a clinician asked for it (an add-on test) and
 * the HMIS does not have the line yet. Nothing reaches the patient's record
 * until a different person confirms; the result is then held from the HMIS
 * until the clinician's order line arrives and is matched (A-34).
 */
export async function proposeAddTest(db: Db, unmatchedId: string, user: string, input: { accessionNo: string; requestedBy: string; reason: string }): Promise<void> {
  const why = input.reason.trim();
  const requestedBy = input.requestedBy.trim();
  if (requestedBy.length < 2 || requestedBy.length > 100) throw reject('REASON_REQUIRED', 'name the clinician who asked for the test (2 to 100 characters)');
  if (why.length < 10) throw reject('REASON_REQUIRED', 'say why the test is added (at least 10 characters), for example how the request came');
  await db.$transaction(async (tx) => {
    const { u, o, specimen, order } = await addTarget(tx, unmatchedId, { accessionNo: input.accessionNo });
    if (u.proposedBy) throw reject('INVALID_STATE', `${u.proposedBy} has already proposed a link; confirm or withdraw it first`);
    const n = await tx.unmatchedResult.updateMany({
      where: { id: unmatchedId, resolvedAt: null, proposedBy: null },
      data: { proposedAction: 'ADD_TEST', proposedSpecimenId: specimen.id, proposedRequestedBy: requestedBy, proposedBy: user, proposedAt: new Date(), proposalReason: why },
    });
    if (n.count !== 1) throw reject('INVALID_STATE', 'changed by someone else; reload');
    await appendAudit(tx, {
      actor: user, action: 'unmatched.add-test-proposed', entityType: 'unmatched_result', entityId: unmatchedId, reason: why,
      after: { accessionNo: specimen.accessionNo, hmisOrderId: order.hmisOrderId, localTestCode: o.localTestCode, requestedBy },
    });
  });
}

type UnmatchedRow = NonNullable<Awaited<ReturnType<Tx['unmatchedResult']['findUnique']>>>;

/** Second person: the test is added to the order with the specimen, and the observation becomes its result. */
async function confirmAddTest(tx: Tx, u0: UnmatchedRow, user: string): Promise<{ resultId: string }> {
  if (!u0.proposedSpecimenId || !u0.proposedRequestedBy || !u0.proposedBy) throw reject('INVALID_STATE', 'no open proposal to confirm');
  const { o, specimen, order } = await addTarget(tx, u0.id, { specimenId: u0.proposedSpecimenId });
  const code = o.localTestCode as string;
  const resolution = `added ${code} to order ${order.hmisOrderId} on ${specimen.accessionNo}, asked for by ${u0.proposedRequestedBy}: proposed by ${u0.proposedBy} (${u0.proposalReason ?? ''}), confirmed by ${user}`;
  const n = await tx.unmatchedResult.updateMany({
    where: { id: u0.id, resolvedAt: null, proposedBy: u0.proposedBy, proposedSpecimenId: u0.proposedSpecimenId },
    data: { resolvedAt: new Date(), resolvedBy: user, resolution },
  });
  if (n.count !== 1) throw reject('INVALID_STATE', 'changed by someone else; reload');
  // The HMIS code that orders this test, when the lab has one; the local code otherwise.
  const hmisCode = (await tx.hmisCodeMap.findFirst({ where: { localTestCode: code }, orderBy: { hmisTestCode: 'asc' } }))?.hmisTestCode ?? code;
  const testId = uuidv7();
  const test = await tx.orderedTest.create({
    data: {
      id: testId, orderId: order.id, hmisLineId: `LAB-ADD-${testId}`, hmisTestCode: hmisCode, localTestCode: code, status: 'active', specimenId: specimen.id,
      source: 'LAB_ADDED', requestedBy: u0.proposedRequestedBy, addedBy: u0.proposedBy, addedConfirmedBy: user, addedReason: u0.proposalReason ?? '', addedAt: new Date(),
    },
  });
  const resultId = await attachObservation(tx, o.normalizedMessage, o, test);
  await tx.unmatchedResult.update({ where: { id: u0.id }, data: { linkedResultId: resultId } });
  await appendAudit(tx, {
    actor: user, action: 'unmatched.add-test-confirmed', entityType: 'unmatched_result', entityId: u0.id, reason: u0.proposalReason ?? '',
    after: { accessionNo: specimen.accessionNo, hmisOrderId: order.hmisOrderId, orderedTestId: test.id, resultId, requestedBy: u0.proposedRequestedBy, proposedBy: u0.proposedBy },
  });
  await appendAudit(tx, {
    actor: user, action: 'order.test-added', entityType: 'lab_order', entityId: order.id, reason: u0.proposalReason ?? '',
    after: { orderedTestId: test.id, localTestCode: code, specimenId: specimen.id, requestedBy: u0.proposedRequestedBy, proposedBy: u0.proposedBy },
  });
  return { resultId };
}

import type { HmisResultSubmission, HmisResultValue, ResultValue, VerificationStatus } from '@lis/contracts';
import { uuidv7, type Db, type JsonInput } from '@lis/db';
import {
  approveResult, clinicalGateFor, correctResult, releaseResult, replayDelivery, reviewResult,
  type ResultAggregate, type ResultStatus, type ResultVersion, type VersionKind, type WorkflowError, type WorkflowPolicy,
} from '@lis/domain';
import { appendAudit } from './audit.js';
import { criticalFor, requireCriticalCall } from './critical.js';
import { deltaColumns, deltaFor } from './delta.js';
import type { Tx } from './tx.js';

export class WorkflowRejected extends Error {
  constructor(readonly error: WorkflowError) {
    super(`${error.code}: ${error.detail}`);
    this.name = 'WorkflowRejected';
  }
}

export class ConcurrentChange extends Error {
  constructor(resultId: string) {
    super(`result ${resultId} was changed by someone else; reload and try again`);
    this.name = 'ConcurrentChange';
  }
}

export interface LoadedResult {
  aggregate: ResultAggregate;
  rowVersion: number;
  instrumentId: string | null;
}

export async function loadResult(tx: Tx | Db, resultId: string): Promise<LoadedResult> {
  const r = await tx.result.findUniqueOrThrow({ where: { id: resultId }, include: { versions: { orderBy: { versionNo: 'asc' } } } });
  const versions: ResultVersion[] = r.versions.map((v) => {
    const out: ResultVersion = { versionNo: v.versionNo, kind: v.kind as VersionKind, value: v.value as unknown as ResultValue, abnormalFlags: v.abnormalFlags, createdBy: v.createdBy };
    if (v.units) out.units = v.units;
    if (v.observationId) out.observationId = v.observationId;
    if (v.reason) out.reason = v.reason;
    return out;
  });
  const a: ResultAggregate = {
    resultId: r.id,
    status: r.status as ResultStatus,
    versions,
    releaseCount: r.releaseCount,
    newDataAfterApproval: r.newDataAfterApproval,
    needsConfirmation: r.needsConfirmation,
  };
  if (r.selectedVersionNo !== null) a.selectedVersionNo = r.selectedVersionNo;
  if (r.reviewedBy) a.reviewedBy = r.reviewedBy;
  if (r.approvedBy) a.approvedBy = r.approvedBy;
  if (r.deliveryKey) a.deliveryKey = r.deliveryKey;
  if (r.deliveredKey) a.deliveredKey = r.deliveredKey;
  return { aggregate: a, rowVersion: r.version, instrumentId: r.instrumentId };
}

/** Write the aggregate back: new versions are inserted (versions are append-only), the row is updated with an optimistic check. */
export async function saveResult(tx: Tx, before: LoadedResult, after: ResultAggregate, actor: string): Promise<void> {
  for (const v of after.versions.slice(before.aggregate.versions.length)) {
    const crit = await criticalFor(tx, after.resultId, v.value, v.units);
    const delta = await deltaFor(tx, after.resultId, v.value, v.units);
    await tx.resultVersion.create({
      data: {
        id: uuidv7(),
        resultId: after.resultId,
        versionNo: v.versionNo,
        kind: v.kind,
        value: v.value as unknown as JsonInput,
        units: v.units ?? null,
        abnormalFlags: v.abnormalFlags,
        observationId: v.observationId ?? null,
        reason: v.reason ?? null,
        createdBy: v.createdBy ?? actor,
        criticalFlag: crit?.flag ?? null,
        criticalLimitId: crit?.limitId ?? null,
        criticalDetail: crit?.detail ?? null,
        ...deltaColumns(delta),
      },
    });
  }
  const n = await tx.result.updateMany({
    where: { id: after.resultId, version: before.rowVersion },
    data: {
      status: after.status,
      selectedVersionNo: after.selectedVersionNo ?? null,
      reviewedBy: after.reviewedBy ?? null,
      approvedBy: after.approvedBy ?? null,
      releaseCount: after.releaseCount,
      deliveryKey: after.deliveryKey ?? null,
      deliveredKey: after.deliveredKey ?? null,
      newDataAfterApproval: after.newDataAfterApproval,
      needsConfirmation: after.needsConfirmation,
      version: { increment: 1 },
      updatedAt: new Date(),
    },
  });
  if (n.count !== 1) throw new ConcurrentChange(after.resultId);
}

function unwrap<T>(r: { ok: true; value: T } | { ok: false; error: WorkflowError }): T {
  if (!r.ok) throw new WorkflowRejected(r.error);
  return r.value;
}

async function command(
  db: Db,
  resultId: string,
  actor: string,
  kind: 'review' | 'approve' | 'replay' | 'correct',
  apply: (a: ResultAggregate) => ResultAggregate,
  reason?: string,
  check?: (tx: Tx, a: ResultAggregate) => Promise<void>,
): Promise<ResultAggregate> {
  return db.$transaction(async (tx) => {
    const before = await loadResult(tx, resultId);
    const after = apply(before.aggregate);
    await check?.(tx, after);
    await saveResult(tx, before, after, actor);
    await tx.resultEvent.create({ data: { id: uuidv7(), resultId, kind, versionNo: after.selectedVersionNo ?? null, actor, reason: reason ?? null } });
    await appendAudit(tx, {
      actor,
      action: `result.${kind}`,
      entityType: 'result',
      entityId: resultId,
      ...(reason ? { reason } : {}),
      before: { status: before.aggregate.status, version: before.aggregate.selectedVersionNo },
      after: { status: after.status, version: after.selectedVersionNo },
    });
    return after;
  });
}

export const review = (db: Db, resultId: string, user: string, versionNo: number) =>
  command(db, resultId, user, 'review', (a) => unwrap(reviewResult(a, user, versionNo)));

export const approve = (db: Db, resultId: string, user: string, policy: WorkflowPolicy) =>
  command(db, resultId, user, 'approve', (a) => unwrap(approveResult(a, user, policy)), undefined, (tx, a) => requireCriticalCall(tx, resultId, a.selectedVersionNo));

export const replay = (db: Db, resultId: string, user: string, reason: string) =>
  command(db, resultId, user, 'replay', (a) => unwrap(replayDelivery(a, reason)), reason).then(async (a) => {
    // Put the outbox row back in the queue too.
    if (a.deliveryKey) await db.outboxMessage.updateMany({ where: { idempotencyKey: a.deliveryKey }, data: { status: 'PENDING', availableAt: new Date(), attempts: 0 } });
    return a;
  });

export const correct = (db: Db, resultId: string, user: string, value: ResultValue, reason: string, units?: string) =>
  command(db, resultId, user, 'correct', (a) => unwrap(correctResult(a, user, value, reason, units ? { units } : {})), reason);

function toHmisValue(v: ResultValue, units?: string): HmisResultValue {
  const unit = units ? { unit: units } : {};
  switch (v.kind) {
    case 'numeric':
      return { type: 'numeric', value: v.value, ...unit };
    case 'censored':
      return { type: 'censored', comparator: v.comparator, value: v.limit, ...unit };
    case 'qualitative':
      return { type: 'coded', code: v.code };
    case 'text':
      return { type: 'text', text: v.text };
    case 'absent':
      throw new WorkflowRejected({ code: 'NOT_RELEASABLE', detail: `no value to release (${v.reason})` });
  }
}

/**
 * Release one approved result: state change, outbox row (with the
 * submission payload) and audit event commit together (08 §3). The
 * database refuses the outbox row if the version was not approved.
 */
export async function release(db: Db, resultId: string, user: { username: string; displayName: string }): Promise<{ idempotencyKey: string }> {
  return db.$transaction(async (tx) => {
    const before = await loadResult(tx, resultId);
    const row = await tx.result.findUniqueOrThrow({
      where: { id: resultId },
      include: { orderedTest: { include: { order: true, specimen: true } } },
    });
    const inst = row.instrumentId ? await tx.instrument.findUnique({ where: { id: row.instrumentId } }) : null;
    const gate = inst
      ? clinicalGateFor({
          enabled: inst.enabled,
          verificationStatus: inst.verificationStatus.toLowerCase() as VerificationStatus,
          softwareVersion: inst.softwareVersion,
          verifiedSoftwareVersion: inst.verifiedSoftwareVersion,
        })
      : ({ releasable: true } as const); // manual entry: no instrument involved
    // 06 §5.2: a downtime order's results wait until the order is reconciled to an HMIS order.
    if (row.orderedTest.order.source === 'MANUAL_DOWNTIME') {
      throw new WorkflowRejected({ code: 'NOT_RELEASABLE', detail: `${row.orderedTest.order.hmisOrderId} is a downtime order; reconcile it to the HMIS order before release` });
    }
    const r = unwrap(releaseResult(before.aggregate, gate));
    await requireCriticalCall(tx, resultId, r.aggregate.selectedVersionNo);
    const version = r.aggregate.versions.find((v) => v.versionNo === r.aggregate.selectedVersionNo) as ResultVersion;
    const t = row.orderedTest;
    const submission: HmisResultSubmission = {
      idempotencyKey: r.idempotencyKey,
      hmisOrderId: t.order.hmisOrderId,
      hmisLineId: t.hmisLineId,
      testCode: t.hmisTestCode,
      status: r.correctionOf ? 'corrected' : 'final',
      value: toHmisValue(version.value, version.units),
      approvedBy: { username: user.username, displayName: user.displayName },
      approvedAt: new Date().toISOString(),
      specimen: { accessionNo: t.specimen?.accessionNo ?? '', ...(t.specimen?.collectedAt ? { collectedAt: t.specimen.collectedAt.toISOString() } : {}) },
      ...(version.abnormalFlags[0] ? { abnormalFlag: version.abnormalFlags[0] } : {}),
      ...(inst ? { instrument: `${inst.model} (${inst.id})` } : {}),
      comments: [],
      correctionOf: r.correctionOf,
      ...(version.reason && r.correctionOf ? { reason: version.reason } : {}),
    };
    await saveResult(tx, before, r.aggregate, user.username);
    await tx.resultEvent.create({ data: { id: uuidv7(), resultId, kind: 'release', versionNo: version.versionNo, actor: user.username, detail: { idempotencyKey: r.idempotencyKey } } });
    await tx.outboxMessage.create({
      data: {
        id: uuidv7(),
        topic: r.correctionOf ? 'hmis.result.correct' : 'hmis.result.submit',
        resultId,
        versionNo: version.versionNo,
        idempotencyKey: r.idempotencyKey,
        payload: submission as unknown as JsonInput,
      },
    });
    await appendAudit(tx, { actor: user.username, action: 'result.release', entityType: 'result', entityId: resultId, after: { idempotencyKey: r.idempotencyKey, version: version.versionNo } });
    return { idempotencyKey: r.idempotencyKey };
  });
}

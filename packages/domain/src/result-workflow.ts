import type { ResultValue, SubmitOutcome } from '@lis/contracts';
import type { ClinicalGate } from './instrument-lifecycle.js';

/**
 * Result lifecycle (06 §4.2). Pure: the caller loads the aggregate, applies
 * one command, and stores the new state, the audit event and (on release)
 * the outbox row in ONE transaction.
 */

export type ResultStatus = 'received' | 'reviewed' | 'approved' | 'queued' | 'sent' | 'hmis_confirmed' | 'failed' | 'corrected';
export type VersionKind = 'initial' | 'repeat' | 'dilution' | 'correction' | 'manual';

export interface ResultVersion {
  versionNo: number;
  kind: VersionKind;
  value: ResultValue;
  units?: string;
  abnormalFlags: string[];
  /** Observation it came from; absent for manual entry and corrections. */
  observationId?: string;
  reason?: string;
  createdBy: string;
}

export interface ResultAggregate {
  resultId: string;
  status: ResultStatus;
  versions: ResultVersion[];
  /** The version the technologist chose; approval and release apply to it. */
  selectedVersionNo?: number;
  reviewedBy?: string;
  approvedBy?: string;
  releaseCount: number;
  /** Key of the release in flight or last delivered. */
  deliveryKey?: string;
  /** Key of the last delivered release, which a correction points at. */
  deliveredKey?: string;
  /** A new instrument value arrived after approval: the approver must decide on a correction. */
  newDataAfterApproval: boolean;
  /** Last delivery was ambiguous: confirm with the HMIS before any resend. */
  needsConfirmation: boolean;
}

export interface WorkflowPolicy {
  /** Reviewer and approver must be different people (10 §2, optional two-person rule). */
  twoPersonRule: boolean;
}

export type WorkflowError = { code: 'INVALID_STATE' | 'SAME_PERSON' | 'NO_SUCH_VERSION' | 'NOT_RELEASABLE' | 'REASON_REQUIRED' | 'CONFIRM_FIRST'; detail: string };
export type WorkflowResult<T = ResultAggregate> = { ok: true; value: T } | { ok: false; error: WorkflowError };

const err = (code: WorkflowError['code'], detail: string): { ok: false; error: WorkflowError } => ({ ok: false, error: { code, detail } });
const ok = <T>(value: T): { ok: true; value: T } => ({ ok: true, value });

export function newResult(resultId: string, first: Omit<ResultVersion, 'versionNo'>): ResultAggregate {
  return {
    resultId,
    status: 'received',
    versions: [{ ...first, versionNo: 1 }],
    selectedVersionNo: 1,
    releaseCount: 0,
    newDataAfterApproval: false,
    needsConfirmation: false,
  };
}

const PRE_APPROVAL: ResultStatus[] = ['received', 'reviewed'];

/** A repeat or dilution from the instrument. Before approval it resets review; after, it only raises an alert. */
export function addInstrumentVersion(a: ResultAggregate, v: Omit<ResultVersion, 'versionNo'>): ResultAggregate {
  const versionNo = a.versions.length + 1;
  const versions = [...a.versions, { ...v, versionNo }];
  if (PRE_APPROVAL.includes(a.status)) {
    const { reviewedBy: _r, ...rest } = a;
    return { ...rest, versions, status: 'received', selectedVersionNo: versionNo };
  }
  return { ...a, versions, newDataAfterApproval: true };
}

export function reviewResult(a: ResultAggregate, user: string, versionNo: number): WorkflowResult {
  if (!PRE_APPROVAL.includes(a.status)) return err('INVALID_STATE', `cannot review a ${a.status} result`);
  if (!a.versions.some((v) => v.versionNo === versionNo)) return err('NO_SUCH_VERSION', `version ${versionNo}`);
  return ok({ ...a, status: 'reviewed', reviewedBy: user, selectedVersionNo: versionNo });
}

export function approveResult(a: ResultAggregate, user: string, policy: WorkflowPolicy): WorkflowResult {
  if (a.status !== 'reviewed') return err('INVALID_STATE', `only a reviewed result can be approved (is ${a.status})`);
  if (policy.twoPersonRule && a.reviewedBy === user) return err('SAME_PERSON', 'reviewer and approver must differ');
  return ok({ ...a, status: 'approved', approvedBy: user });
}

export const releaseKey = (resultId: string, versionNo: number, releaseNo: number) => `res:${resultId}:v${versionNo}:release:${releaseNo}`;

/**
 * Release to the HMIS. Allowed only for an approved (or approved correction)
 * result from an instrument that passes the clinical gate. Returns the
 * idempotency key the outbox row must carry.
 */
export function releaseResult(a: ResultAggregate, gate: ClinicalGate): WorkflowResult<{ aggregate: ResultAggregate; idempotencyKey: string; correctionOf: string | null }> {
  if (a.status !== 'approved') return err('INVALID_STATE', `only an approved result can be released (is ${a.status})`);
  if (!gate.releasable) return err('NOT_RELEASABLE', `instrument not cleared for clinical use: ${gate.detail}`);
  const versionNo = a.selectedVersionNo as number;
  const releaseNo = a.releaseCount + 1;
  const idempotencyKey = releaseKey(a.resultId, versionNo, releaseNo);
  const isCorrection = a.versions.find((v) => v.versionNo === versionNo)?.kind === 'correction';
  return ok({
    aggregate: { ...a, status: 'queued', releaseCount: releaseNo, deliveryKey: idempotencyKey },
    idempotencyKey,
    correctionOf: isCorrection ? (a.deliveredKey ?? null) : null,
  });
}

/** Apply the outcome of one delivery attempt (07 §6.5). */
export function deliveryOutcome(a: ResultAggregate, o: SubmitOutcome, attemptsExhausted: boolean): ResultAggregate {
  if (a.status !== 'queued') return a;
  switch (o.kind) {
    case 'accepted':
      return { ...a, status: 'sent', needsConfirmation: false, ...(a.deliveryKey ? { deliveredKey: a.deliveryKey } : {}) };
    case 'rejected':
      return { ...a, status: 'failed', needsConfirmation: false };
    case 'retryable':
      return attemptsExhausted ? { ...a, status: 'failed' } : a;
    case 'ambiguous':
      return { ...a, needsConfirmation: true };
  }
}

/** Read-back after "sent" or after an ambiguous attempt. */
export function confirmation(a: ResultAggregate, found: { matches: boolean } | null): ResultAggregate {
  if (a.status === 'queued' && a.needsConfirmation) {
    // The HMIS has it: treat as delivered. It does not: safe to resend.
    if (found?.matches) return { ...a, status: 'hmis_confirmed', needsConfirmation: false, ...(a.deliveryKey ? { deliveredKey: a.deliveryKey } : {}) };
    if (found && !found.matches) return { ...a, status: 'failed', needsConfirmation: false };
    return { ...a, needsConfirmation: false };
  }
  if (a.status !== 'sent') return a;
  if (found?.matches) return { ...a, status: 'hmis_confirmed' };
  return { ...a, status: 'failed' };
}

/** Authorised replay of a failed delivery, with a reason (audited by the caller). */
export function replayDelivery(a: ResultAggregate, reason: string): WorkflowResult {
  if (a.status !== 'failed') return err('INVALID_STATE', `only a failed delivery can be replayed (is ${a.status})`);
  if (reason.trim().length < 5) return err('REASON_REQUIRED', 'a replay needs a reason');
  return ok({ ...a, status: 'queued', needsConfirmation: false });
}

/**
 * Correct a delivered result: a new CORRECTION version with a mandatory
 * reason, approved by the person making it; the previous version stays.
 * Release it with `releaseResult()` like any approved result.
 */
export function correctResult(a: ResultAggregate, approver: string, value: ResultValue, reason: string, extra: { units?: string; abnormalFlags?: string[] } = {}): WorkflowResult {
  if (a.status !== 'sent' && a.status !== 'hmis_confirmed') return err('INVALID_STATE', `only a delivered result can be corrected (is ${a.status})`);
  if (reason.trim().length < 10) return err('REASON_REQUIRED', 'a correction needs a reason of at least 10 characters');
  const versionNo = a.versions.length + 1;
  const v: ResultVersion = { versionNo, kind: 'correction', value, abnormalFlags: extra.abnormalFlags ?? [], reason, createdBy: approver, ...(extra.units ? { units: extra.units } : {}) };
  return ok({ ...a, versions: [...a.versions, v], selectedVersionNo: versionNo, status: 'approved', approvedBy: approver, newDataAfterApproval: false });
}

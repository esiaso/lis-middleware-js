import { describe, expect, it } from 'vitest';
import {
  addInstrumentVersion, approveResult, confirmation, correctResult, deliveryOutcome, newResult, releaseResult, replayDelivery, reviewResult,
  type ResultAggregate,
} from '@lis/domain';

const v = (value: string) => ({ kind: 'initial' as const, value: { kind: 'numeric' as const, value, scale: 2 }, abnormalFlags: [], createdBy: 'system:analyzer' });
const policy = { twoPersonRule: true };
const open = { releasable: true as const };

function approved(): ResultAggregate {
  const r1 = reviewResult(newResult('r1', v('1.25')), 'tech', 1);
  if (!r1.ok) throw new Error();
  const r2 = approveResult(r1.value, 'approver', policy);
  if (!r2.ok) throw new Error();
  return r2.value;
}

function delivered(): ResultAggregate {
  const rel = releaseResult(approved(), open);
  if (!rel.ok) throw new Error();
  return confirmation(deliveryOutcome(rel.value.aggregate, { kind: 'accepted', hmisResultId: 'HR-1' }, false), { matches: true });
}

describe('result workflow', () => {
  it('goes received → reviewed → approved → queued with an idempotency key', () => {
    const r = releaseResult(approved(), open);
    expect(r).toMatchObject({ ok: true, value: { idempotencyKey: 'res:r1:v1:release:1', correctionOf: null, aggregate: { status: 'queued', releaseCount: 1 } } });
  });

  it('cannot skip review or approval, and blocks self-approval under the two-person rule', () => {
    const a = newResult('r1', v('1'));
    expect(approveResult(a, 'x', policy)).toMatchObject({ ok: false, error: { code: 'INVALID_STATE' } });
    expect(releaseResult(a, open)).toMatchObject({ ok: false, error: { code: 'INVALID_STATE' } });
    const r = reviewResult(a, 'tech', 1);
    if (!r.ok) throw new Error();
    expect(approveResult(r.value, 'tech', policy)).toMatchObject({ ok: false, error: { code: 'SAME_PERSON' } });
    expect(approveResult(r.value, 'tech', { twoPersonRule: false }).ok).toBe(true);
  });

  it('does not release results from an instrument that is not cleared for clinical use', () => {
    expect(releaseResult(approved(), { releasable: false, reason: 'not-lab-accepted', detail: 'verification status is unverified' })).toMatchObject({
      ok: false,
      error: { code: 'NOT_RELEASABLE' },
    });
  });

  it('a repeat before approval resets review; after approval it only raises an alert', () => {
    const r = reviewResult(newResult('r1', v('1.25')), 'tech', 1);
    if (!r.ok) throw new Error();
    const reset = addInstrumentVersion(r.value, { ...v('1.30'), kind: 'repeat' });
    expect(reset).toMatchObject({ status: 'received', selectedVersionNo: 2 });
    expect(reset.reviewedBy).toBeUndefined();
    const late = addInstrumentVersion(approved(), { ...v('9.99'), kind: 'repeat' });
    expect(late).toMatchObject({ status: 'approved', selectedVersionNo: 1, newDataAfterApproval: true });
  });

  it('settles an ambiguous delivery by read-back before any resend', () => {
    const rel = releaseResult(approved(), open);
    if (!rel.ok) throw new Error();
    const amb = deliveryOutcome(rel.value.aggregate, { kind: 'ambiguous', reason: 'timeout after send' }, false);
    expect(amb).toMatchObject({ status: 'queued', needsConfirmation: true });
    expect(confirmation(amb, { matches: true })).toMatchObject({ status: 'hmis_confirmed', deliveredKey: 'res:r1:v1:release:1' });
    expect(confirmation(amb, null)).toMatchObject({ status: 'queued', needsConfirmation: false });
  });

  it('fails on rejection or exhausted retries, and replays only with a reason', () => {
    const rel = releaseResult(approved(), open);
    if (!rel.ok) throw new Error();
    const q = rel.value.aggregate;
    expect(deliveryOutcome(q, { kind: 'retryable', reason: '503' }, false).status).toBe('queued');
    const failed = deliveryOutcome(q, { kind: 'retryable', reason: '503' }, true);
    expect(failed.status).toBe('failed');
    expect(deliveryOutcome(q, { kind: 'rejected', reason: '422' }, false).status).toBe('failed');
    expect(replayDelivery(failed, '')).toMatchObject({ ok: false, error: { code: 'REASON_REQUIRED' } });
    expect(replayDelivery(failed, 'HMIS fixed the code map')).toMatchObject({ ok: true, value: { status: 'queued' } });
  });

  it('corrects a delivered result with a new version that points at the delivered key', () => {
    const d = delivered();
    expect(correctResult(d, 'approver', { kind: 'numeric', value: '1.52', scale: 2 }, 'short')).toMatchObject({ ok: false, error: { code: 'REASON_REQUIRED' } });
    const c = correctResult(d, 'approver', { kind: 'numeric', value: '1.52', scale: 2 }, 'transcription of dilution factor was wrong');
    if (!c.ok) throw new Error();
    expect(c.value.versions.map((x) => x.kind)).toEqual(['initial', 'correction']);
    const rel = releaseResult(c.value, open);
    expect(rel).toMatchObject({ ok: true, value: { idempotencyKey: 'res:r1:v2:release:2', correctionOf: 'res:r1:v1:release:1' } });
  });
});

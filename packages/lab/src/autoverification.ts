import type { InstrumentFlag, ResultValue, VerificationStatus } from '@lis/contracts';
import { uuidv7, type Db, type JsonInput } from '@lis/db';
import { AUTOVERIFY_ACTOR, autoverifyResult, clinicalGateFor, evaluateAutoverification, parseAutoverifyRule, type AutoverifyCheck, type AutoverifyRuleInput, type VersionKind } from '@lis/domain';
import { appendAudit } from './audit.js';
import { InvalidInput } from './instruments.js';
import { loadResult, saveResult, WorkflowRejected } from './results.js';
import type { Tx } from './tx.js';

/**
 * Autoverification (08 §12, A-19). Runs once, on the first value of a new
 * result, inside the intake transaction. Without an active rule for the test
 * nothing happens and the result waits for a person, as it always has. A
 * pass approves the result as "system:autoverify"; release stays manual.
 */
export interface FirstValue {
  kind: VersionKind;
  value: ResultValue;
  units: string | null | undefined;
  abnormalFlags: string[];
  instrumentFlags: InstrumentFlag[];
  editedOnInstrument: boolean;
  criticalFlag: string | null;
}

export async function autoverifyNewResult(tx: Tx, resultId: string, instrumentId: string, v: FirstValue): Promise<boolean> {
  const r = await tx.result.findUniqueOrThrow({ where: { id: resultId }, select: { orderedTest: { select: { localTestCode: true } } } });
  const code = r.orderedTest.localTestCode;
  if (!code) return false;
  const rule = await tx.autoverifyRule.findFirst({ where: { localTestCode: code, active: true } });
  if (!rule) return false;
  const inst = await tx.instrument.findUnique({ where: { id: instrumentId } });
  const gate = inst
    ? clinicalGateFor({ enabled: inst.enabled, verificationStatus: inst.verificationStatus.toLowerCase() as VerificationStatus, softwareVersion: inst.softwareVersion, verifiedSoftwareVersion: inst.verifiedSoftwareVersion })
    : ({ releasable: false, reason: 'disabled', detail: 'unknown instrument' } as const);
  const outcome = evaluateAutoverification(rule, {
    kind: v.kind,
    value: v.value,
    units: v.units,
    abnormalFlags: v.abnormalFlags,
    instrumentFlags: v.instrumentFlags.map((f) => f.code),
    editedOnInstrument: v.editedOnInstrument,
    criticalFlag: v.criticalFlag,
    instrumentCleared: gate.releasable,
  });
  await tx.autoverificationDecision.create({ data: { id: uuidv7(), resultId, versionNo: 1, ruleId: rule.id, passed: outcome.passed, checks: outcome.checks as unknown as JsonInput } });
  if (!outcome.passed) return false;
  const before = await loadResult(tx, resultId);
  const after = autoverifyResult(before.aggregate);
  if (!after.ok) return false;
  await saveResult(tx, before, after.value, AUTOVERIFY_ACTOR);
  // The approve event is what the outbox trigger looks for when a person releases it.
  await tx.resultEvent.create({ data: { id: uuidv7(), resultId, kind: 'approve', versionNo: 1, actor: AUTOVERIFY_ACTOR, reason: `autoverified under rule ${rule.id} (${rule.reference})` } });
  await appendAudit(tx, { actor: AUTOVERIFY_ACTOR, action: 'result.autoverify', entityType: 'result', entityId: resultId, after: { status: 'approved', version: 1, ruleId: rule.id } });
  return true;
}

export interface StoredDecision {
  versionNo: number;
  passed: boolean;
  checks: AutoverifyCheck[];
  at: Date;
  reference: string;
}

export async function decisionsFor(db: Db | Tx, resultId: string): Promise<StoredDecision[]> {
  const rows = await db.autoverificationDecision.findMany({ where: { resultId }, include: { rule: { select: { reference: true } } }, orderBy: { at: 'asc' } });
  return rows.map((d) => ({ versionNo: d.versionNo, passed: d.passed, checks: d.checks as unknown as AutoverifyCheck[], at: d.at, reference: d.rule.reference }));
}

export async function addAutoverifyRule(db: Db, actor: string, input: AutoverifyRuleInput): Promise<string> {
  const p = parseAutoverifyRule(input);
  if (!p.ok) throw new InvalidInput(p.issues);
  const id = uuidv7();
  await db.$transaction(async (tx) => {
    if (await tx.autoverifyRule.findFirst({ where: { localTestCode: p.value.localTestCode, active: true } })) {
      throw new InvalidInput([`${p.value.localTestCode} already has an active rule. Retire it first.`]);
    }
    await tx.autoverifyRule.create({ data: { id, ...p.value, qcAcknowledged: true, createdBy: actor } });
    await appendAudit(tx, { actor, action: 'autoverify-rule.add', entityType: 'autoverify_rule', entityId: id, after: { ...p.value, qcAcknowledged: true } });
  });
  return id;
}

export async function retireAutoverifyRule(db: Db, actor: string, id: string, reason: string): Promise<void> {
  if (reason.trim().length < 5) throw new InvalidInput(['Give a reason of at least 5 characters.']);
  await db.$transaction(async (tx) => {
    const n = await tx.autoverifyRule.updateMany({ where: { id, active: true }, data: { active: false, retiredBy: actor, retiredAt: new Date(), retireReason: reason.trim() } });
    if (n.count !== 1) throw new WorkflowRejected({ code: 'INVALID_STATE', detail: 'that rule is not active' });
    await appendAudit(tx, { actor, action: 'autoverify-rule.retire', entityType: 'autoverify_rule', entityId: id, reason: reason.trim() });
  });
}

import type { ResultValue } from '@lis/contracts';
import { uuidv7, type Db } from '@lis/db';
import { ageInDays, evaluateCritical, parseCriticalLimit, type CriticalLimitInput, type CriticalOutcome } from '@lis/domain';
import { appendAudit } from './audit.js';
import { activeEntry } from './catalogue.js';
import { InvalidInput } from './instruments.js';
import { WorkflowRejected } from './results.js';
import type { Tx } from './tx.js';

/**
 * Critical results (08 §12): limits set by the lab director, a flag on each
 * version as it is written, and a record of who was told. The middleware
 * holds no limits of its own; until the lab enters them nothing is flagged.
 */

export const NEEDS_CALL = ['LOW', 'HIGH', 'ANSWER'] as const;

/** Flag for a version about to be written to this result. */
export async function criticalFor(tx: Tx, resultId: string, value: ResultValue, units: string | undefined | null): Promise<CriticalOutcome | null> {
  if (value.kind === 'qualitative') return criticalAnswer(tx, resultId, value.code);
  if (value.kind !== 'numeric' && value.kind !== 'censored') return null;
  const r = await tx.result.findUniqueOrThrow({ where: { id: resultId }, select: { orderedTest: { select: { localTestCode: true, specimen: { select: { collectedAt: true } }, order: { select: { patient: { select: { sex: true, birthDate: true } } } } } } } });
  const t = r.orderedTest;
  if (!t.localTestCode) return null;
  const limits = await tx.criticalLimit.findMany({ where: { localTestCode: t.localTestCode, active: true }, orderBy: { createdAt: 'asc' } });
  if (!limits.length) return null;
  const p = t.order.patient;
  return evaluateCritical(value, units, limits, { sex: p.sex, ageDays: ageInDays(p.birthDate, t.specimen?.collectedAt ?? new Date()) });
}

/**
 * A choice answer the lab director marked critical in the catalogue (A-36),
 * such as a positive malaria smear. The active catalogue entry is read when
 * the version is written, so a later catalogue change does not move old flags.
 */
async function criticalAnswer(tx: Tx, resultId: string, code: string): Promise<CriticalOutcome | null> {
  const r = await tx.result.findUniqueOrThrow({ where: { id: resultId }, select: { orderedTest: { select: { localTestCode: true } } } });
  const local = r.orderedTest.localTestCode;
  if (!local) return null;
  const def = await activeEntry(tx, local);
  const a = (def?.answers ?? []).find((x) => x.code.toUpperCase() === code.toUpperCase());
  if (!def || !a?.critical) return null;
  return { flag: 'ANSWER', limitId: null, detail: `${a.display} is a critical answer for ${def.localCode} (catalogue version ${def.versionNo})` };
}

/** Approval and release of a LOW, HIGH or ANSWER version wait until someone has recorded telling the clinician. */
export async function requireCriticalCall(tx: Tx, resultId: string, versionNo: number | undefined): Promise<void> {
  if (versionNo === undefined) return;
  const v = await tx.resultVersion.findUnique({ where: { resultId_versionNo: { resultId, versionNo } }, select: { criticalFlag: true, criticalDetail: true } });
  if (!v?.criticalFlag || !(NEEDS_CALL as readonly string[]).includes(v.criticalFlag)) return;
  const call = await tx.criticalCall.findFirst({ where: { resultId, versionNo } });
  if (!call) throw new WorkflowRejected({ code: 'CRITICAL_NOT_COMMUNICATED', detail: `this is a critical result (${v.criticalDetail ?? v.criticalFlag.toLowerCase()}); record who was told, with read-back, before it can be approved or released` });
}

export interface CriticalCallInput {
  versionNo: number;
  notified: string;
  notifiedRole: string;
  calledAt: Date | null;
  readBack: boolean;
  note: string;
}

/** Record that a clinician was told about a critical version and read it back. */
export async function recordCriticalCall(db: Db, resultId: string, actor: string, i: CriticalCallInput, now = new Date()): Promise<void> {
  const issues: string[] = [];
  const notified = i.notified.trim();
  const role = i.notifiedRole.trim();
  if (notified.length < 2 || notified.length > 80) issues.push('Name of the person told: 2 to 80 characters.');
  if (role.length < 2 || role.length > 80) issues.push('Their role and ward: 2 to 80 characters.');
  if (!i.calledAt || Number.isNaN(i.calledAt.getTime())) issues.push('Enter when they were told.');
  else if (i.calledAt.getTime() > now.getTime() + 60_000) issues.push('The time they were told cannot be in the future.');
  if (!i.readBack) issues.push('Tick read-back only once they have read the value back to you. If they could not, call again.');
  if (i.note.length > 500) issues.push('Note: at most 500 characters.');
  if (issues.length) throw new InvalidInput(issues);
  await db.$transaction(async (tx) => {
    const v = await tx.resultVersion.findUnique({ where: { resultId_versionNo: { resultId, versionNo: i.versionNo } } });
    if (!v || !v.criticalFlag || !(NEEDS_CALL as readonly string[]).includes(v.criticalFlag)) throw new WorkflowRejected({ code: 'INVALID_STATE', detail: `version ${i.versionNo} is not a critical result` });
    if (i.calledAt!.getTime() < v.createdAt.getTime() - 60_000) throw new InvalidInput(['The time they were told is before the result arrived.']);
    const id = uuidv7();
    await tx.criticalCall.create({ data: { id, resultId, versionNo: i.versionNo, notified, notifiedRole: role, calledAt: i.calledAt!, readBack: true, note: i.note.trim() || null, recordedBy: actor } });
    await tx.resultEvent.create({ data: { id: uuidv7(), resultId, kind: 'critical-call', versionNo: i.versionNo, actor, reason: `told ${notified} (${role}), read back`, detail: { callId: id } } });
    await appendAudit(tx, { actor, action: 'result.critical-call', entityType: 'result', entityId: resultId, after: { versionNo: i.versionNo, notified, notifiedRole: role, calledAt: i.calledAt!.toISOString(), readBack: true } });
  });
}

export interface WaitingCritical {
  resultId: string;
  versionNo: number;
  flag: string;
  detail: string;
  arrivedAt: Date;
  test: string;
  mrn: string;
  familyName: string | null;
  givenName: string | null;
  location: string | null;
  accessionNo: string | null;
}

/**
 * Critical versions nobody has recorded a call for, oldest first. A version
 * superseded before approval by a later selected one (a repeat that came
 * back normal) is left out; one that arrived after approval is kept.
 */
export async function waitingCriticals(db: Db | Tx, limit = 100): Promise<WaitingCritical[]> {
  return db.$queryRaw<WaitingCritical[]>`
    SELECT r.id AS "resultId", v.version_no AS "versionNo", v.critical_flag AS flag, COALESCE(v.critical_detail, '') AS detail, v.created_at AS "arrivedAt",
           COALESCE(t.local_test_code, t.hmis_test_code) AS test, p.mrn, p.family_name AS "familyName", p.given_name AS "givenName", o.location, s.accession_no AS "accessionNo"
      FROM result_version v
      JOIN result r ON r.id = v.result_id
      JOIN ordered_test t ON t.id = r.ordered_test_id
      JOIN lab_order o ON o.id = t.order_id
      JOIN patient p ON p.id = o.patient_id
      LEFT JOIN specimen s ON s.id = t.specimen_id
     WHERE v.critical_flag IN ('LOW', 'HIGH', 'ANSWER')
       AND v.version_no >= COALESCE(r.selected_version_no, 0)
       AND NOT EXISTS (SELECT 1 FROM critical_call c WHERE c.result_id = v.result_id AND c.version_no = v.version_no)
     ORDER BY v.created_at ASC
     LIMIT ${limit}`;
}

export async function addCriticalLimit(db: Db, actor: string, input: CriticalLimitInput): Promise<string> {
  const p = parseCriticalLimit(input);
  if (!p.ok) throw new InvalidInput(p.issues);
  const id = uuidv7();
  await db.$transaction(async (tx) => {
    await tx.criticalLimit.create({ data: { id, ...p.value, createdBy: actor } });
    await appendAudit(tx, { actor, action: 'critical-limit.add', entityType: 'critical_limit', entityId: id, after: p.value });
  });
  return id;
}

export async function retireCriticalLimit(db: Db, actor: string, id: string, reason: string): Promise<void> {
  if (reason.trim().length < 5) throw new InvalidInput(['Give a reason of at least 5 characters.']);
  await db.$transaction(async (tx) => {
    const n = await tx.criticalLimit.updateMany({ where: { id, active: true }, data: { active: false, retiredBy: actor, retiredAt: new Date(), retireReason: reason.trim() } });
    if (n.count !== 1) throw new WorkflowRejected({ code: 'INVALID_STATE', detail: 'that limit is not active' });
    await appendAudit(tx, { actor, action: 'critical-limit.retire', entityType: 'critical_limit', entityId: id, reason: reason.trim() });
  });
}

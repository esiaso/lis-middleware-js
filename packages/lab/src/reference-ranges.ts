import type { ResultValue } from '@lis/contracts';
import { uuidv7, type Db } from '@lis/db';
import { ageInDays, describeReference, describeReferenceWho, parseReferenceRange, referenceFor, referenceMark, type ReferenceMark, type ReferenceRangeInput } from '@lis/domain';
import { appendAudit } from './audit.js';
import { InvalidInput } from './instruments.js';
import { WorkflowRejected } from './results.js';
import type { Tx } from './tx.js';

/**
 * Reference ranges entered by the lab (01 A-25). Looked up when a page or
 * the printed report is drawn, using the ranges that were in force when the
 * value was stored, so retiring a range never rewrites an older report.
 */
export interface ReferenceLookup {
  localTestCode: string | null;
  sex: string | null;
  birthDate: Date | null;
  /** Collection time, for the patient's age. */
  collectedAt: Date | null;
  /** When the value was stored: picks the ranges in force then. */
  storedAt: Date;
  value: ResultValue;
  units: string | null;
}

export interface ReferenceShown {
  text: string;
  who: string;
  source: string;
  mark: ReferenceMark;
}

/** The lab's range for each value, or null where none applies. One query for the lot. */
export async function labReferences(db: Db | Tx, items: ReferenceLookup[]): Promise<(ReferenceShown | null)[]> {
  const codes = [...new Set(items.map((i) => i.localTestCode).filter((c): c is string => !!c))];
  if (!codes.length) return items.map(() => null);
  const all = await db.referenceRange.findMany({ where: { localTestCode: { in: codes } }, orderBy: { createdAt: 'asc' } });
  return items.map((i) => {
    if (!i.localTestCode) return null;
    const inForce = all.filter((r) => r.localTestCode === i.localTestCode && r.createdAt <= i.storedAt && (r.retiredAt === null || r.retiredAt > i.storedAt));
    const r = referenceFor(inForce, { sex: i.sex === 'F' || i.sex === 'M' ? i.sex : null, ageDays: ageInDays(i.birthDate, i.collectedAt ?? i.storedAt) });
    return r ? { text: describeReference(r), who: describeReferenceWho(r), source: r.reference, mark: referenceMark(i.value, i.units, r) } : null;
  });
}

/** The reference range text the instrument sent with this value, if it sent one. */
export async function instrumentReferenceText(db: Db | Tx, observationId: string | null): Promise<string | null> {
  if (!observationId) return null;
  const o = await db.observation.findUnique({ where: { id: observationId }, select: { seq: true, normalizedMessage: { select: { payload: true } } } });
  const payload = o?.normalizedMessage.payload as { observations?: { referenceRangeText?: string }[] } | undefined;
  return payload?.observations?.[o!.seq - 1]?.referenceRangeText?.trim() || null;
}

export async function addReferenceRange(db: Db, actor: string, input: ReferenceRangeInput): Promise<string> {
  const p = parseReferenceRange(input);
  if (!p.ok) throw new InvalidInput(p.issues);
  const id = uuidv7();
  await db.$transaction(async (tx) => {
    const clash = await tx.referenceRange.findFirst({ where: { localTestCode: p.value.localTestCode, sex: p.value.sex, ageMinDays: p.value.ageMinDays, ageMaxDays: p.value.ageMaxDays, active: true } });
    if (clash) throw new InvalidInput(['That test already has an active range for the same patients. Retire it first.']);
    await tx.referenceRange.create({ data: { id, ...p.value, createdBy: actor } });
    await appendAudit(tx, { actor, action: 'reference-range.add', entityType: 'reference_range', entityId: id, after: p.value });
  });
  return id;
}

export async function retireReferenceRange(db: Db, actor: string, id: string, reason: string): Promise<void> {
  if (reason.trim().length < 5) throw new InvalidInput(['Give a reason of at least 5 characters.']);
  await db.$transaction(async (tx) => {
    const n = await tx.referenceRange.updateMany({ where: { id, active: true }, data: { active: false, retiredBy: actor, retiredAt: new Date(), retireReason: reason.trim() } });
    if (n.count !== 1) throw new WorkflowRejected({ code: 'INVALID_STATE', detail: 'that range is not active' });
    await appendAudit(tx, { actor, action: 'reference-range.retire', entityType: 'reference_range', entityId: id, reason: reason.trim() });
  });
}

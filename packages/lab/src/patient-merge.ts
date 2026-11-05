import { uuidv7, type Db } from '@lis/db';
import { appendAudit } from './audit.js';
import { InvalidInput } from './instruments.js';
import { WorkflowRejected } from './results.js';
import type { Tx } from './tx.js';

/**
 * Patient merges (D-6, A-35). When medical records merge two MRNs in the HMIS,
 * the lab records the merge here: one person proposes it with the HMIS or
 * medical records reference, a different person confirms it. Orders, results
 * and what was sent to the HMIS keep the MRN they arrived with; the surviving
 * patient's history, cumulative report and delta checks include the merged
 * one. Nothing is deleted and nothing is moved.
 */

const reject = (code: 'INVALID_STATE' | 'SAME_PERSON', detail: string) => new WorkflowRejected({ code, detail });

/** This patient and every patient merged into it, directly or through others. */
export async function mergedGroup(db: Db | Tx, patientId: string): Promise<string[]> {
  const rows = await db.$queryRaw<{ id: string }[]>`
    WITH RECURSIVE g(id) AS (
      SELECT ${patientId}::uuid
      UNION
      SELECT p.id FROM patient p JOIN g ON p.merged_into_id = g.id
    )
    SELECT id::text AS id FROM g`;
  return rows.map((r) => r.id);
}

/** The patient a record now belongs to: itself, or the end of its merge chain. */
export async function survivingPatient(db: Db | Tx, patientId: string): Promise<string> {
  let id = patientId;
  for (let i = 0; i < 50; i++) {
    const p = await db.patient.findUnique({ where: { id }, select: { mergedIntoId: true } });
    if (!p?.mergedIntoId) return id;
    id = p.mergedIntoId;
  }
  return id;
}

/** Every patient record of the same person: the surviving patient and all merged into it. */
export async function samePerson(db: Db | Tx, patientId: string): Promise<string[]> {
  return mergedGroup(db, await survivingPatient(db, patientId));
}

async function checkPair(tx: Tx, fromId: string, intoId: string) {
  const from = await tx.patient.findUnique({ where: { id: fromId } });
  const into = await tx.patient.findUnique({ where: { id: intoId } });
  if (!from || !into) throw reject('INVALID_STATE', 'no such patient');
  if (from.id === into.id) throw reject('INVALID_STATE', 'a patient cannot be merged into itself');
  if (from.provisional || into.provisional) throw reject('INVALID_STATE', 'a provisional downtime patient is reconciled from the downtime page, not merged');
  if (from.mergedIntoId) throw reject('INVALID_STATE', `MRN ${from.mrn} is already merged`);
  if (into.mergedIntoId) throw reject('INVALID_STATE', `MRN ${into.mrn} was itself merged; merge into the patient it was merged into`);
  return { from, into };
}

export interface MergeProposal {
  fromPatientId: string;
  /** The surviving MRN, as the HMIS now has it. */
  intoMrn: string;
  reference: string;
  reason: string;
}

/** First person: propose that this patient's MRN was merged into another in the HMIS. */
export async function proposeMerge(db: Db, user: string, input: MergeProposal): Promise<string> {
  const issues: string[] = [];
  const reference = input.reference.trim();
  const reason = input.reason.trim();
  const intoMrn = input.intoMrn.trim();
  if (!intoMrn) issues.push('Give the MRN the patient keeps.');
  if (reference.length < 3 || reference.length > 100) issues.push('Give the HMIS or medical records reference for the merge, 3 to 100 characters.');
  if (reason.length < 10 || reason.length > 500) issues.push('Say why, in 10 to 500 characters (for example "duplicate registration at outpatients, merged by medical records").');
  if (issues.length) throw new InvalidInput(issues);
  return db.$transaction(async (tx) => {
    const into = await tx.patient.findFirst({ where: { mrn: { equals: intoMrn, mode: 'insensitive' } } });
    if (!into) throw new InvalidInput([`No patient with MRN ${intoMrn} has come from the HMIS yet.`]);
    const { from } = await checkPair(tx, input.fromPatientId, into.id);
    if (await tx.patientMerge.findFirst({ where: { fromPatientId: from.id, status: 'PROPOSED' } })) throw reject('INVALID_STATE', `a merge of MRN ${from.mrn} is already waiting; confirm or withdraw it first`);
    const id = uuidv7();
    await tx.patientMerge.create({ data: { id, fromPatientId: from.id, intoPatientId: into.id, reference, reason, proposedBy: user } });
    await appendAudit(tx, { actor: user, action: 'patient.merge-proposed', entityType: 'patient', entityId: from.id, reason, after: { mergeId: id, fromMrn: from.mrn, intoMrn: into.mrn, reference } });
    return id;
  });
}

/** Second person: the merge takes effect. */
export async function confirmMerge(db: Db, user: string, mergeId: string): Promise<void> {
  await db.$transaction(async (tx) => {
    const m = await tx.patientMerge.findUnique({ where: { id: mergeId } });
    if (!m || m.status !== 'PROPOSED') throw reject('INVALID_STATE', 'no merge waiting to be confirmed');
    if (m.proposedBy === user) throw reject('SAME_PERSON', 'a different person must confirm the merge');
    const { from, into } = await checkPair(tx, m.fromPatientId, m.intoPatientId);
    const now = new Date();
    const n = await tx.patientMerge.updateMany({ where: { id: m.id, status: 'PROPOSED' }, data: { status: 'CONFIRMED', decidedBy: user, decidedAt: now } });
    if (n.count !== 1) throw reject('INVALID_STATE', 'changed by someone else; reload');
    await tx.patient.update({ where: { id: from.id }, data: { mergedIntoId: into.id } });
    const who = (p: typeof from) => ({ mrn: p.mrn, familyName: p.familyName, givenName: p.givenName, sex: p.sex, birthDate: p.birthDate?.toISOString().slice(0, 10) ?? null });
    await appendAudit(tx, {
      actor: user, action: 'patient.merged', entityType: 'patient', entityId: from.id, reason: m.reason,
      before: { from: who(from), into: who(into) }, after: { mergeId: m.id, mergedIntoId: into.id, reference: m.reference, proposedBy: m.proposedBy },
    });
  });
}

/** Take back a proposal; anyone allowed to propose may do this. */
export async function withdrawMerge(db: Db, user: string, mergeId: string): Promise<void> {
  await db.$transaction(async (tx) => {
    const n = await tx.patientMerge.updateMany({ where: { id: mergeId, status: 'PROPOSED' }, data: { status: 'WITHDRAWN', decidedBy: user, decidedAt: new Date() } });
    if (n.count !== 1) throw reject('INVALID_STATE', 'no merge waiting');
    const m = await tx.patientMerge.findUniqueOrThrow({ where: { id: mergeId } });
    await appendAudit(tx, { actor: user, action: 'patient.merge-withdrawn', entityType: 'patient', entityId: m.fromPatientId, after: { mergeId } });
  });
}

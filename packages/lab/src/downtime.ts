import { TestMapping } from '@lis/contracts';
import { z } from 'zod';
import { uuidv7, type Db } from '@lis/db';
import { appendAudit } from './audit.js';
import { WorkflowRejected } from './results.js';

/**
 * Downtime registration and reconciliation (06 §5.2, A-5).
 *
 * While the HMIS cannot be reached, the lab registers a provisional patient
 * and a downtime order ("DT-000001") by hand. Specimens are collected and
 * labelled as usual and results can be reviewed and approved, but nothing is
 * released to the HMIS from a downtime order. When the HMIS order arrives, a
 * person links the two: specimens and results move onto the HMIS order's
 * matching tests, and the provisional patient is marked as merged (never
 * deleted). Release then works as for any HMIS order.
 */

export const DOWNTIME = 'MANUAL_DOWNTIME';

const reject = (code: 'INVALID_STATE' | 'REASON_REQUIRED', detail: string) => new WorkflowRejected({ code, detail });

/** Local test codes the lab can order by hand: those known from HMIS code mappings and active instrument mappings. */
export async function downtimeTestCatalogue(db: Db): Promise<string[]> {
  const [codeMap, sets] = await Promise.all([
    db.hmisCodeMap.findMany({ select: { localTestCode: true } }),
    db.testMappingSet.findMany({ where: { status: 'ACTIVE' }, select: { mappingsJson: true } }),
  ]);
  const codes = new Set(codeMap.map((c) => c.localTestCode));
  for (const s of sets) {
    const parsed = z.array(TestMapping).safeParse(s.mappingsJson);
    if (parsed.success) for (const m of parsed.data) codes.add(m.localTestCode);
  }
  return [...codes].sort();
}

export interface DowntimeRegistration {
  familyName: string;
  givenName?: string;
  birthDate?: Date;
  sex?: 'F' | 'M' | 'U';
  /** The MRN on the patient's card or request form, if any. Used only to find the HMIS order later. */
  claimedMrn?: string;
  location?: string;
  clinician?: string;
  priority: 'routine' | 'stat';
  tests: string[];
  specimenType?: string;
}

export async function registerDowntimeOrder(db: Db, input: DowntimeRegistration, user: string): Promise<{ orderId: string; downtimeId: string }> {
  const familyName = input.familyName.trim();
  if (familyName.length < 1) throw reject('INVALID_STATE', 'family name is required');
  const tests = [...new Set(input.tests.map((t) => t.trim()).filter(Boolean))];
  if (tests.length === 0) throw reject('INVALID_STATE', 'choose at least one test');
  const catalogue = new Set(await downtimeTestCatalogue(db));
  const unknown = tests.filter((t) => !catalogue.has(t));
  if (unknown.length) throw reject('INVALID_STATE', `not in the test list: ${unknown.join(', ')}`);
  if (input.birthDate && input.birthDate.getTime() > Date.now()) throw reject('INVALID_STATE', 'birth date is in the future');

  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(724103)`;
    const n = (await tx.labOrder.count({ where: { source: DOWNTIME } })) + 1;
    const seq = String(n).padStart(6, '0');
    const downtimeId = `DT-${seq}`;
    const patientId = uuidv7();
    const orderId = uuidv7();
    const now = new Date();
    await tx.patient.create({
      data: {
        id: patientId,
        mrn: `PROV-${seq}`,
        familyName,
        givenName: input.givenName?.trim() || null,
        birthDate: input.birthDate ?? null,
        sex: input.sex ?? null,
        provisional: true,
      },
    });
    const claimedMrn = input.claimedMrn?.trim() || null;
    await tx.labOrder.create({
      data: {
        id: orderId,
        hmisOrderId: downtimeId,
        patientId,
        location: input.location?.trim() || null,
        orderingClinician: input.clinician?.trim() || null,
        priority: input.priority,
        orderedAt: now,
        status: 'active',
        source: DOWNTIME,
        sourceJson: { registeredBy: user, registeredAt: now.toISOString(), claimedMrn, tests },
      },
    });
    await tx.orderedTest.createMany({
      data: tests.map((code, i) => ({
        id: uuidv7(),
        orderId,
        hmisLineId: String(i + 1),
        hmisTestCode: `LOCAL:${code}`,
        localTestCode: code,
        specimenType: input.specimenType?.trim() || null,
        status: 'active',
      })),
    });
    await appendAudit(tx, { actor: user, action: 'order.downtime-registered', entityType: 'lab_order', entityId: orderId, after: { downtimeId, tests, claimedMrn, priority: input.priority } });
    return { orderId, downtimeId };
  });
}

export interface ReconciliationCandidate {
  orderId: string;
  hmisOrderId: string;
  orderedAt: Date;
  patient: { mrn: string; familyName: string | null; givenName: string | null; birthDate: Date | null; sex: string | null };
  score: number;
  why: string[];
  /** Downtime tests with a specimen or result that this HMIS order has no free matching test for. */
  missing: string[];
}

/** HMIS orders that may be the real order behind a downtime order, best first. A person decides. */
export async function reconciliationCandidates(db: Db, downtimeOrderId: string): Promise<ReconciliationCandidate[]> {
  const dt = await db.labOrder.findUnique({ where: { id: downtimeOrderId }, include: { patient: true, tests: { include: { result: true } } } });
  if (!dt || dt.source !== DOWNTIME) throw reject('INVALID_STATE', 'not a downtime order');
  const claimedMrn = (dt.sourceJson as { claimedMrn?: string | null } | null)?.claimedMrn ?? null;
  const p = dt.patient;
  const day = 24 * 3600_000;
  const orders = await db.labOrder.findMany({
    where: {
      source: 'HMIS',
      status: 'active',
      orderedAt: { gte: new Date(dt.orderedAt.getTime() - 3 * day), lte: new Date(dt.orderedAt.getTime() + 3 * day) },
      patient: {
        OR: [
          ...(claimedMrn ? [{ mrn: claimedMrn }] : []),
          ...(p.birthDate ? [{ birthDate: p.birthDate }] : []),
          ...(p.familyName ? [{ familyName: { equals: p.familyName, mode: 'insensitive' as const } }] : []),
        ],
      },
    },
    include: { patient: true, tests: { include: { result: true } } },
    take: 50,
  });
  const needed = dt.tests.filter((t) => t.status === 'active' && (t.specimenId || t.result)).map((t) => t.localTestCode as string);
  const out = orders.map((o) => {
    const why: string[] = [];
    let score = 0;
    if (claimedMrn && o.patient.mrn === claimedMrn) (score += 4), why.push('MRN');
    if (p.birthDate && o.patient.birthDate && o.patient.birthDate.getTime() === p.birthDate.getTime()) (score += 2), why.push('birth date');
    if (p.familyName && o.patient.familyName?.toLowerCase() === p.familyName.toLowerCase()) (score += 2), why.push('family name');
    if (p.givenName && o.patient.givenName?.toLowerCase() === p.givenName.toLowerCase()) (score += 1), why.push('given name');
    const free = o.tests.filter((t) => t.status === 'active' && !t.specimenId && !t.result).map((t) => t.localTestCode);
    const missing = needed.filter((code) => {
      const i = free.indexOf(code);
      if (i < 0) return true;
      free.splice(i, 1);
      return false;
    });
    if (needed.length && missing.length === 0) (score += 1), why.push('tests');
    return { orderId: o.id, hmisOrderId: o.hmisOrderId, orderedAt: o.orderedAt, patient: o.patient, score, why, missing };
  });
  return out.sort((a, b) => b.score - a.score || a.orderedAt.getTime() - b.orderedAt.getTime()).slice(0, 10);
}

/**
 * Move a downtime order's specimens and results onto an HMIS order. Each
 * downtime test that has a specimen or a result needs a free HMIS test with
 * the same local code; otherwise nothing moves. Tests never collected are
 * closed as reconciled. Accession numbers and barcodes do not change, so
 * instruments and labels are unaffected.
 */
export async function reconcileDowntimeOrder(db: Db, downtimeOrderId: string, hmisOrderUuid: string, user: string): Promise<{ moved: number }> {
  return db.$transaction(async (tx) => {
    const dt = await tx.labOrder.findUnique({ where: { id: downtimeOrderId }, include: { patient: true, tests: { include: { result: true } }, specimens: true } });
    if (!dt || dt.source !== DOWNTIME) throw reject('INVALID_STATE', 'not a downtime order');
    if (dt.reconciledAt) throw reject('INVALID_STATE', `already reconciled by ${dt.reconciledBy}`);
    const hmis = await tx.labOrder.findUnique({ where: { id: hmisOrderUuid }, include: { tests: { include: { result: true } } } });
    if (!hmis || hmis.source !== 'HMIS') throw reject('INVALID_STATE', 'choose an order that came from the HMIS');
    if (hmis.status !== 'active') throw reject('INVALID_STATE', `HMIS order ${hmis.hmisOrderId} is ${hmis.status}`);

    const free = hmis.tests.filter((t) => t.status === 'active' && !t.specimenId && !t.result);
    const moves: { from: (typeof dt.tests)[number]; to: (typeof hmis.tests)[number] }[] = [];
    const missing: string[] = [];
    for (const t of dt.tests) {
      if (t.status !== 'active' || (!t.specimenId && !t.result)) continue;
      const i = free.findIndex((h) => h.localTestCode === t.localTestCode);
      if (i < 0) missing.push(t.localTestCode as string);
      else moves.push({ from: t, to: free.splice(i, 1)[0]! });
    }
    if (missing.length) throw reject('INVALID_STATE', `HMIS order ${hmis.hmisOrderId} has no free ${missing.join(', ')}; ask for the test to be ordered in the HMIS, then try again`);

    for (const s of dt.specimens) await tx.specimen.update({ where: { id: s.id }, data: { orderId: hmis.id } });
    for (const { from, to } of moves) {
      // Free the downtime test first: a specimen link and a result belong to one test at a time.
      await tx.orderedTest.update({ where: { id: from.id }, data: { specimenId: null, status: 'reconciled' } });
      await tx.orderedTest.update({ where: { id: to.id }, data: { specimenId: from.specimenId } });
      if (from.result) await tx.result.update({ where: { id: from.result.id }, data: { orderedTestId: to.id } });
    }
    await tx.orderedTest.updateMany({ where: { orderId: dt.id, status: 'active' }, data: { status: 'reconciled' } });
    const now = new Date();
    await tx.labOrder.update({ where: { id: dt.id }, data: { status: 'reconciled', reconciledToId: hmis.id, reconciledAt: now, reconciledBy: user } });
    await tx.patient.update({ where: { id: dt.patientId }, data: { mergedIntoId: hmis.patientId } });
    await appendAudit(tx, {
      actor: user,
      action: 'order.downtime-reconciled',
      entityType: 'lab_order',
      entityId: dt.id,
      after: { hmisOrderId: hmis.hmisOrderId, provisionalPatient: dt.patient.mrn, moves: moves.map((m) => ({ test: m.from.localTestCode, from: m.from.id, to: m.to.id, resultId: m.from.result?.id ?? null })) },
    });
    for (const s of dt.specimens) {
      await appendAudit(tx, { actor: user, action: 'specimen.reconciled', entityType: 'specimen', entityId: s.id, reason: `${dt.hmisOrderId} reconciled to HMIS order ${hmis.hmisOrderId}`, after: { fromOrderId: dt.id, toOrderId: hmis.id } });
    }
    return { moved: moves.length };
  });
}

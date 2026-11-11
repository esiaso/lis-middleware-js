import { createHash } from 'node:crypto';
import { uuidv7, type Db, type JsonInput } from '@lis/db';
import { newResult, readManualValue } from '@lis/domain';
import { appendAudit } from './audit.js';
import { activeCatalogue, activeEntry, type CatalogueEntry } from './catalogue.js';
import { criticalFor } from './critical.js';
import { deltaColumns, deltaFor } from './delta.js';
import { InvalidInput } from './instruments.js';
import { WorkflowRejected } from './results.js';
import type { Tx } from './tx.js';

/**
 * Send-outs (A-43): tests the lab does not do itself go to a referral lab.
 * The lab keeps a list of referral labs and, for each, the tests it does
 * with the agreed turnaround. A send-out records which tests of a received
 * specimen went where and when, the courier or waybill number, when the
 * referral lab received it and its number for it, and the papers that come
 * back (its receiving report and its result report) as files. The values on
 * the result report are typed in, saved as manual results that name the
 * referral lab and report, and approved by someone other than the typist,
 * like any other result. The turnaround clock runs from dispatch to the
 * result being typed in.
 */

export const DOCUMENT_MAX_BYTES = 5 * 1024 * 1024;
export const DOCUMENT_KINDS = ['receiving-report', 'result-report', 'other'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];
const CLOSED_TEST = ['cancelled', 'reconciled'];

// ---------------------------------------------------------------- referral labs

export interface ReferralLabInput {
  code: string;
  name: string;
  address: string;
  phone: string;
  email: string;
  notes: string;
}

export function parseReferralLab(form: Partial<Record<keyof ReferralLabInput, string>>): { ok: true; value: ReferralLabInput } | { ok: false; issues: string[] } {
  const t = (k: keyof ReferralLabInput) => (form[k] ?? '').replace(/\r\n?/g, '\n').trim();
  const v: ReferralLabInput = { code: t('code').toUpperCase(), name: t('name'), address: t('address'), phone: t('phone'), email: t('email'), notes: t('notes') };
  const issues: string[] = [];
  if (!/^[A-Z0-9][A-Z0-9._-]{0,19}$/.test(v.code)) issues.push('Give a short code of 1 to 20 capital letters, digits, dots, dashes or underscores, such as KEMRI.');
  if (v.name.length < 2 || v.name.length > 120) issues.push('Give the lab name (2 to 120 characters).');
  if (v.address.length > 300) issues.push('Address is at most 300 characters.');
  if (v.phone.length > 60) issues.push('Phone is at most 60 characters.');
  if (v.email && (v.email.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email))) issues.push('The email address does not look right.');
  if (v.notes.length > 500) issues.push('Notes are at most 500 characters.');
  return issues.length ? { ok: false, issues } : { ok: true, value: v };
}

const labColumns = (v: ReferralLabInput) => ({ code: v.code, name: v.name, address: v.address || null, phone: v.phone || null, email: v.email || null, notes: v.notes || null });

export async function createReferralLab(db: Db, actor: string, form: Partial<Record<keyof ReferralLabInput, string>>): Promise<string> {
  const p = parseReferralLab(form);
  if (!p.ok) throw new InvalidInput(p.issues);
  return db.$transaction(async (tx) => {
    if (await tx.referralLab.findUnique({ where: { code: p.value.code } })) throw new InvalidInput([`A referral lab with code ${p.value.code} already exists.`]);
    const id = uuidv7();
    await tx.referralLab.create({ data: { id, ...labColumns(p.value), createdBy: actor } });
    await appendAudit(tx, { actor, action: 'referral-lab.create', entityType: 'referral_lab', entityId: id, after: labColumns(p.value) });
    return id;
  });
}

export async function updateReferralLab(db: Db, actor: string, id: string, form: Partial<Record<keyof ReferralLabInput, string>>, active: boolean): Promise<void> {
  const p = parseReferralLab(form);
  if (!p.ok) throw new InvalidInput(p.issues);
  await db.$transaction(async (tx) => {
    const before = await tx.referralLab.findUnique({ where: { id } });
    if (!before) throw new WorkflowRejected({ code: 'INVALID_STATE', detail: 'no such referral lab' });
    if (before.code !== p.value.code && (await tx.referralLab.findUnique({ where: { code: p.value.code } }))) throw new InvalidInput([`A referral lab with code ${p.value.code} already exists.`]);
    const data = { ...labColumns(p.value), active };
    await tx.referralLab.update({ where: { id }, data: { ...data, updatedBy: actor, updatedAt: new Date() } });
    await appendAudit(tx, {
      actor,
      action: 'referral-lab.update',
      entityType: 'referral_lab',
      entityId: id,
      before: { code: before.code, name: before.name, address: before.address, phone: before.phone, email: before.email, notes: before.notes, active: before.active },
      after: data,
    });
  });
}

export async function addReferralTest(db: Db, actor: string, labId: string, input: { localTestCode: string; tatHours: string; specimenNote: string }): Promise<void> {
  const code = input.localTestCode.trim();
  const hours = Number(input.tatHours.trim());
  const note = input.specimenNote.trim();
  const issues: string[] = [];
  if (!code) issues.push('Pick the test.');
  if (!Number.isInteger(hours) || hours < 1 || hours > 2160) issues.push('Give the agreed turnaround in whole hours, 1 to 2160 (90 days).');
  if (note.length > 300) issues.push('What to send is at most 300 characters.');
  if (issues.length) throw new InvalidInput(issues);
  await db.$transaction(async (tx) => {
    const lab = await tx.referralLab.findUnique({ where: { id: labId } });
    if (!lab) throw new WorkflowRejected({ code: 'INVALID_STATE', detail: 'no such referral lab' });
    if (!(await activeEntry(tx, code))) throw new InvalidInput([`${code} is not an approved test in the catalogue.`]);
    if (await tx.referralTest.findFirst({ where: { labId, localTestCode: code, active: true } })) throw new InvalidInput([`${lab.code} already has ${code}. Retire it first to change its turnaround.`]);
    const id = uuidv7();
    await tx.referralTest.create({ data: { id, labId, localTestCode: code, tatHours: hours, specimenNote: note || null, createdBy: actor } });
    await appendAudit(tx, { actor, action: 'referral-test.add', entityType: 'referral_test', entityId: id, after: { lab: lab.code, localTestCode: code, tatHours: hours, specimenNote: note || null } });
  });
}

export async function retireReferralTest(db: Db, actor: string, id: string): Promise<string> {
  return db.$transaction(async (tx) => {
    const t = await tx.referralTest.findUnique({ where: { id } });
    if (!t || !t.active) throw new WorkflowRejected({ code: 'INVALID_STATE', detail: 'no such active referral test' });
    await tx.referralTest.update({ where: { id }, data: { active: false, retiredBy: actor, retiredAt: new Date() } });
    await appendAudit(tx, { actor, action: 'referral-test.retire', entityType: 'referral_test', entityId: id, before: { localTestCode: t.localTestCode, tatHours: t.tatHours } });
    return t.labId;
  });
}

// ---------------------------------------------------------------- to send

export interface SendCandidate {
  orderedTestId: string;
  code: string;
  name: string;
  /** Referral labs that do this test, with their turnaround. */
  labs: { labId: string; code: string; name: string; tatHours: number }[];
}
export interface SendCard {
  specimenId: string;
  accessionNo: string;
  hmisOrderId: string;
  orderId: string;
  priority: string;
  receivedAt: Date | null;
  patient: { mrn: string; name: string };
  tests: SendCandidate[];
}

const PRIORITY_RANK: Record<string, number> = { stat: 0, urgent: 1, routine: 2 };
const pendingHere = { status: { notIn: CLOSED_TEST }, result: null, sendOuts: { none: { active: true } }, order: { status: { notIn: ['cancelled', 'reconciled'] } } };

/**
 * Received specimens with tests waiting to be sent out: by default the tests
 * some referral lab does; with an accession, every waiting test of that
 * specimen, so a test the lab usually does can be sent when it cannot.
 */
export async function sendOutWorklist(db: Db | Tx, opts: { accessionNo?: string } = {}): Promise<SendCard[]> {
  const accession = (opts.accessionNo ?? '').trim().toUpperCase();
  const agreements = await db.referralTest.findMany({ where: { active: true, lab: { active: true } }, include: { lab: true }, orderBy: { tatHours: 'asc' } });
  const labsFor = new Map<string, SendCandidate['labs']>();
  for (const a of agreements) labsFor.set(a.localTestCode, [...(labsFor.get(a.localTestCode) ?? []), { labId: a.labId, code: a.lab.code, name: a.lab.name, tatHours: a.tatHours }]);
  if (!accession && labsFor.size === 0) return [];
  const names = new Map((await activeCatalogue(db)).map((e: CatalogueEntry) => [e.localCode, e.name]));
  const tests = await db.orderedTest.findMany({
    where: { ...pendingHere, ...(accession ? {} : { localTestCode: { in: [...labsFor.keys()] } }), specimen: { status: 'received', ...(accession ? { accessionNo: accession } : {}) } },
    include: { specimen: true, order: { include: { patient: true } } },
    orderBy: { hmisLineId: 'asc' },
    take: 500,
  });
  const cards = new Map<string, SendCard>();
  for (const t of tests) {
    const s = t.specimen!;
    let c = cards.get(s.id);
    if (!c) {
      const p = t.order.patient;
      c = { specimenId: s.id, accessionNo: s.accessionNo, hmisOrderId: t.order.hmisOrderId, orderId: t.orderId, priority: t.order.priority, receivedAt: s.receivedAt, patient: { mrn: p.mrn, name: [p.familyName?.toUpperCase(), p.givenName].filter(Boolean).join(', ') }, tests: [] };
      cards.set(s.id, c);
    }
    const code = t.localTestCode ?? t.hmisTestCode;
    c.tests.push({ orderedTestId: t.id, code, name: names.get(code) ?? code, labs: labsFor.get(code) ?? [] });
  }
  return [...cards.values()].sort((a, b) => (PRIORITY_RANK[a.priority] ?? 3) - (PRIORITY_RANK[b.priority] ?? 3) || (a.receivedAt?.getTime() ?? 0) - (b.receivedAt?.getTime() ?? 0) || a.accessionNo.localeCompare(b.accessionNo));
}

// ---------------------------------------------------------------- send

export async function createSendOut(db: Db, actor: string, input: { specimenId: string; labId: string; orderedTestIds: string[]; dispatchedAt?: Date; dispatchRef?: string }): Promise<string> {
  const dispatchRef = (input.dispatchRef ?? '').trim();
  const issues: string[] = [];
  if (!input.labId) issues.push('Pick the referral lab.');
  if (input.orderedTestIds.length === 0) issues.push('Tick at least one test to send.');
  if (dispatchRef.length > 100) issues.push('The courier or waybill number is at most 100 characters.');
  const dispatchedAt = input.dispatchedAt ?? new Date();
  if (dispatchedAt.getTime() > Date.now() + 5 * 60_000) issues.push('The dispatch time is in the future.');
  if (issues.length) throw new InvalidInput(issues);
  return db.$transaction(async (tx) => {
    const lab = await tx.referralLab.findUnique({ where: { id: input.labId } });
    if (!lab || !lab.active) throw new InvalidInput(['That referral lab is not on the list (or is no longer used).']);
    const tests = await tx.orderedTest.findMany({ where: { id: { in: input.orderedTestIds } }, include: { specimen: true, result: true, order: true, sendOuts: { where: { active: true } } } });
    if (tests.length !== new Set(input.orderedTestIds).size || tests.some((t) => t.specimenId !== input.specimenId)) throw new WorkflowRejected({ code: 'INVALID_STATE', detail: 'these tests are not all on this specimen' });
    const spec = tests[0]!.specimen!;
    if (spec.status !== 'received') throw new InvalidInput(['Receive the specimen in the lab before sending it out.']);
    const agreements = new Map((await tx.referralTest.findMany({ where: { labId: lab.id, active: true } })).map((a) => [a.localTestCode, a.tatHours]));
    for (const t of tests) {
      const code = t.localTestCode ?? t.hmisTestCode;
      if (t.result) issues.push(`${code} already has a result.`);
      else if (CLOSED_TEST.includes(t.status) || t.order.status === 'cancelled' || t.order.status === 'reconciled') issues.push(`${code} is cancelled.`);
      else if (t.sendOuts.length) issues.push(`${code} is already sent out.`);
      else if (!agreements.has(code)) issues.push(`${lab.code} has no agreed turnaround for ${code}. Add it on the referral lab's page first.`);
    }
    if (issues.length) throw new InvalidInput(issues);
    const hours = tests.map((t) => agreements.get(t.localTestCode ?? t.hmisTestCode)!);
    const id = uuidv7();
    const dueAt = new Date(dispatchedAt.getTime() + Math.max(...hours) * 3_600_000);
    await tx.sendOut.create({ data: { id, specimenId: spec.id, labId: lab.id, status: 'sent', dispatchedAt, dispatchedBy: actor, dispatchRef: dispatchRef || null, dueAt } });
    for (const [i, t] of tests.entries()) await tx.sendOutTest.create({ data: { id: uuidv7(), sendOutId: id, orderedTestId: t.id, tatHours: hours[i]! } });
    await appendAudit(tx, {
      actor,
      action: 'send-out.dispatch',
      entityType: 'send_out',
      entityId: id,
      after: { accessionNo: spec.accessionNo, lab: lab.code, tests: tests.map((t) => t.localTestCode ?? t.hmisTestCode), dispatchedAt: dispatchedAt.toISOString(), dispatchRef: dispatchRef || null, dueAt: dueAt.toISOString() },
    });
    return id;
  });
}

export async function recordReferralReceipt(db: Db, actor: string, id: string, input: { receivedAt?: Date; labRef: string }): Promise<void> {
  const labRef = input.labRef.trim();
  if (labRef.length > 60) throw new InvalidInput(['The referral lab number is at most 60 characters.']);
  await db.$transaction(async (tx) => {
    const s = await tx.sendOut.findUnique({ where: { id } });
    if (!s) throw new WorkflowRejected({ code: 'INVALID_STATE', detail: 'no such send-out' });
    if (s.status !== 'sent' && s.status !== 'received') throw new InvalidInput([`This send-out is ${s.status}.`]);
    const receivedAt = input.receivedAt ?? new Date();
    if (receivedAt < s.dispatchedAt) throw new InvalidInput(['The referral lab cannot have received it before it was sent.']);
    if (receivedAt.getTime() > Date.now() + 5 * 60_000) throw new InvalidInput(['The time received is in the future.']);
    await tx.sendOut.update({ where: { id }, data: { status: 'received', labReceivedAt: receivedAt, labReceivedBy: actor, labRef: labRef || null } });
    await appendAudit(tx, { actor, action: 'send-out.lab-received', entityType: 'send_out', entityId: id, before: { labReceivedAt: s.labReceivedAt?.toISOString() ?? null, labRef: s.labRef }, after: { labReceivedAt: receivedAt.toISOString(), labRef: labRef || null } });
  });
}

export async function cancelSendOut(db: Db, actor: string, id: string, reason: string): Promise<void> {
  const why = reason.trim();
  if (why.length < 5 || why.length > 300) throw new InvalidInput(['Say why the send-out is cancelled (5 to 300 characters), such as "specimen leaked in transit".']);
  await db.$transaction(async (tx) => {
    const s = await tx.sendOut.findUnique({ where: { id }, include: { tests: { include: { orderedTest: { include: { result: true } } } } } });
    if (!s) throw new WorkflowRejected({ code: 'INVALID_STATE', detail: 'no such send-out' });
    if (s.status === 'cancelled' || s.status === 'resulted') throw new InvalidInput([`This send-out is ${s.status}.`]);
    if (s.tests.some((t) => t.orderedTest.result)) throw new InvalidInput(['A result is already typed in from this send-out, so it cannot be cancelled. Correct the result on its page instead.']);
    await tx.sendOutTest.updateMany({ where: { sendOutId: id }, data: { active: false } });
    await tx.sendOut.update({ where: { id }, data: { status: 'cancelled', cancelledAt: new Date(), cancelledBy: actor, cancelReason: why } });
    await appendAudit(tx, { actor, action: 'send-out.cancel', entityType: 'send_out', entityId: id, reason: why, before: { status: s.status } });
  });
}

// ---------------------------------------------------------------- documents

/** The file type from its first bytes: PDF, PNG or JPEG only. */
export function documentType(bytes: Uint8Array): 'application/pdf' | 'image/png' | 'image/jpeg' | null {
  if (bytes.length >= 5 && String.fromCharCode(...bytes.subarray(0, 5)) === '%PDF-') return 'application/pdf';
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= 8 && png.every((b, i) => bytes[i] === b)) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  return null;
}

/** A safe name to show and to download as: letters, digits, dots, dashes, underscores and spaces. */
export function cleanFileName(name: string, type: string): string {
  const ext = type === 'application/pdf' ? '.pdf' : type === 'image/png' ? '.png' : '.jpg';
  const base = (name.split(/[\\/]/).pop() ?? '').replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(/[^A-Za-z0-9 ._-]+/g, '_').trim().slice(0, 80) || 'document';
  return base + ext;
}

export async function addSendOutDocument(db: Db, actor: string, id: string, input: { kind: string; fileName: string; bytes: Uint8Array; note?: string }): Promise<string> {
  const note = (input.note ?? '').trim();
  const issues: string[] = [];
  if (!DOCUMENT_KINDS.includes(input.kind as DocumentKind)) issues.push('Say what the file is: receiving report, result report or other.');
  if (input.bytes.length === 0) issues.push('Choose a file to upload.');
  else if (input.bytes.length > DOCUMENT_MAX_BYTES) issues.push(`The file is ${(input.bytes.length / 1048576).toFixed(1)} MB; it can be at most 5 MB.`);
  const type = input.bytes.length ? documentType(input.bytes) : null;
  if (input.bytes.length && !type) issues.push('The file must be a PDF, PNG or JPEG (a scan or photo of the paper).');
  if (note.length > 300) issues.push('The note is at most 300 characters.');
  if (issues.length) throw new InvalidInput(issues);
  const sha256 = createHash('sha256').update(input.bytes).digest('hex');
  return db.$transaction(async (tx) => {
    const s = await tx.sendOut.findUnique({ where: { id } });
    if (!s) throw new WorkflowRejected({ code: 'INVALID_STATE', detail: 'no such send-out' });
    const docId = uuidv7();
    const fileName = cleanFileName(input.fileName, type!);
    await tx.sendOutDocument.create({ data: { id: docId, sendOutId: id, kind: input.kind, fileName, contentType: type!, bytes: Buffer.from(input.bytes), size: input.bytes.length, sha256, note: note || null, uploadedBy: actor } });
    await appendAudit(tx, { actor, action: 'send-out.document', entityType: 'send_out', entityId: id, after: { documentId: docId, kind: input.kind, fileName, contentType: type, size: input.bytes.length, sha256 } });
    return docId;
  });
}

export async function sendOutDocument(db: Db, sendOutId: string, docId: string): Promise<{ fileName: string; contentType: string; bytes: Buffer } | null> {
  const d = await db.sendOutDocument.findFirst({ where: { id: docId, sendOutId } });
  return d ? { fileName: d.fileName, contentType: d.contentType, bytes: Buffer.from(d.bytes) } : null;
}

// ---------------------------------------------------------------- results

export interface ReferralDetail {
  performedBy: string;
  referral: { sendOutId: string; labCode: string; labName: string; reportRef: string };
  catalogueVersion: number;
}

/**
 * Type in values from the referral lab's result report. Empty fields stay
 * for later; one bad value saves none. Each result names the referral lab
 * and report, and someone other than the typist approves it.
 */
export async function enterSendOutResults(db: Db, actor: string, id: string, input: { reportRef: string; values: { orderedTestId: string; value: string }[] }): Promise<string[]> {
  const reportRef = input.reportRef.trim();
  const filled = input.values.filter((v) => v.value.trim());
  const issues: string[] = [];
  if (reportRef.length < 1 || reportRef.length > 60) issues.push("Give the referral lab's report number (up to 60 characters), so the value can be found on the paper.");
  if (filled.length === 0) issues.push('Enter at least one result. Empty fields stay for later.');
  if (issues.length) throw new InvalidInput(issues);
  return db.$transaction(async (tx) => {
    const s = await tx.sendOut.findUnique({ where: { id }, include: { lab: true, tests: { where: { active: true } } } });
    if (!s) throw new WorkflowRejected({ code: 'INVALID_STATE', detail: 'no such send-out' });
    if (s.status === 'cancelled') throw new InvalidInput(['This send-out was cancelled.']);
    const onIt = new Set(s.tests.map((t) => t.orderedTestId));
    if (filled.some((v) => !onIt.has(v.orderedTestId))) throw new WorkflowRejected({ code: 'INVALID_STATE', detail: 'a test is not on this send-out' });
    const ids: string[] = [];
    const problems: string[] = [];
    for (const v of filled) {
      try {
        ids.push(await enterOne(tx, actor, v, { sendOutId: s.id, labCode: s.lab.code, labName: s.lab.name, reportRef }));
      } catch (e) {
        if (!(e instanceof InvalidInput)) throw e;
        const t = await tx.orderedTest.findUnique({ where: { id: v.orderedTestId } });
        problems.push(...e.issues.map((i) => `${t?.localTestCode ?? ''}: ${i}`));
      }
    }
    if (problems.length) throw new InvalidInput(problems); // rolls back the ones that passed
    const left = await tx.orderedTest.count({ where: { id: { in: [...onIt] }, result: null } });
    if (left === 0) await tx.sendOut.update({ where: { id }, data: { status: 'resulted', resultedAt: new Date() } });
    return ids;
  });
}

async function enterOne(tx: Tx, actor: string, input: { orderedTestId: string; value: string }, ref: ReferralDetail['referral']): Promise<string> {
  const t = await tx.orderedTest.findUnique({ where: { id: input.orderedTestId }, include: { result: true, order: true } });
  if (!t) throw new WorkflowRejected({ code: 'INVALID_STATE', detail: 'no such ordered test' });
  if (t.result) throw new InvalidInput(['already has a result; change it from the result page.']);
  if (CLOSED_TEST.includes(t.status) || t.order.status === 'cancelled') throw new InvalidInput(['this test is cancelled.']);
  const def = t.localTestCode ? await activeEntry(tx, t.localTestCode) : null;
  if (!def) throw new InvalidInput([`${t.localTestCode ?? t.hmisTestCode} is not an approved test in the catalogue.`]);
  const v = readManualValue(def, input.value);
  if (!v.ok) throw new InvalidInput([v.issue]);
  const resultId = uuidv7();
  const agg = newResult(resultId, { kind: 'manual', value: v.value, abnormalFlags: v.abnormalFlags, createdBy: actor, ...(v.units ? { units: v.units } : {}) });
  await tx.result.create({ data: { id: resultId, orderedTestId: t.id, status: agg.status, selectedVersionNo: 1 } });
  const crit = await criticalFor(tx, resultId, v.value, v.units);
  const delta = await deltaFor(tx, resultId, v.value, v.units);
  await tx.resultVersion.create({
    data: {
      id: uuidv7(), resultId, versionNo: 1, kind: 'manual', value: v.value as unknown as JsonInput, units: v.units ?? null, abnormalFlags: v.abnormalFlags, createdBy: actor,
      criticalFlag: crit?.flag ?? null, criticalLimitId: crit?.limitId ?? null, criticalDetail: crit?.detail ?? null,
      ...deltaColumns(delta),
    },
  });
  const detail: ReferralDetail = { performedBy: ref.labName, referral: ref, catalogueVersion: def.versionNo };
  await tx.resultEvent.create({ data: { id: uuidv7(), resultId, kind: 'enter', versionNo: 1, actor, detail: detail as unknown as JsonInput } });
  await appendAudit(tx, { actor, action: 'result.referral-entry', entityType: 'result', entityId: resultId, after: { orderedTestId: t.id, localTestCode: def.localCode, value: v.value, ...detail } });
  return resultId;
}

// ---------------------------------------------------------------- the list

export type SendOutState = 'awaiting' | 'overdue' | 'on-time' | 'late' | 'cancelled';

export interface SentTestRow {
  sendOutId: string;
  orderedTestId: string;
  code: string;
  lab: { id: string; code: string; name: string };
  accessionNo: string;
  patient: { id: string; mrn: string; name: string };
  dispatchedAt: Date;
  dispatchRef: string | null;
  labReceivedAt: Date | null;
  labRef: string | null;
  tatHours: number;
  dueAt: Date;
  resultedAt: Date | null;
  resultId: string | null;
  /** Hours from dispatch to the result, or to now while waiting. */
  hours: number;
  state: SendOutState;
}

/** Every sent-out test with its turnaround and where it stands, most overdue first. */
export async function sentTests(db: Db | Tx, opts: { labId?: string; state?: SendOutState | ''; search?: string; now?: Date; skip?: number; take?: number } = {}): Promise<{ rows: SentTestRow[]; total: number; counts: Record<SendOutState, number> }> {
  const now = opts.now ?? new Date();
  const q = (opts.search ?? '').trim();
  const all = await db.sendOutTest.findMany({
    where: {
      ...(opts.labId ? { sendOut: { labId: opts.labId } } : {}),
      ...(q ? { OR: [{ sendOut: { specimen: { accessionNo: q.toUpperCase() } } }, { orderedTest: { order: { patient: { mrn: { startsWith: q, mode: 'insensitive' as const } } } } }, { orderedTest: { localTestCode: q.toUpperCase() } }] } : {}),
    },
    include: { sendOut: { include: { lab: true, specimen: true } }, orderedTest: { include: { result: { include: { events: { where: { kind: 'enter' }, orderBy: { at: 'asc' }, take: 1 } } }, order: { include: { patient: true } } } } },
    take: 5000,
  });
  const rows: SentTestRow[] = all.map((x) => {
    const s = x.sendOut;
    const due = new Date(s.dispatchedAt.getTime() + x.tatHours * 3_600_000);
    const r = x.orderedTest.result;
    const resultedAt = r ? (r.events[0]?.at ?? null) : null;
    const end = resultedAt ?? now;
    const state: SendOutState = !x.active ? 'cancelled' : resultedAt ? (resultedAt <= due ? 'on-time' : 'late') : now > due ? 'overdue' : 'awaiting';
    const p = x.orderedTest.order.patient;
    return {
      sendOutId: s.id,
      orderedTestId: x.orderedTestId,
      code: x.orderedTest.localTestCode ?? x.orderedTest.hmisTestCode,
      lab: { id: s.lab.id, code: s.lab.code, name: s.lab.name },
      accessionNo: s.specimen.accessionNo,
      patient: { id: p.id, mrn: p.mrn, name: [p.familyName?.toUpperCase(), p.givenName].filter(Boolean).join(', ') },
      dispatchedAt: s.dispatchedAt,
      dispatchRef: s.dispatchRef,
      labReceivedAt: s.labReceivedAt,
      labRef: s.labRef,
      tatHours: x.tatHours,
      dueAt: due,
      resultedAt,
      resultId: r?.id ?? null,
      hours: Math.max(0, Math.round(((end.getTime() - s.dispatchedAt.getTime()) / 3_600_000) * 10) / 10),
      state,
    };
  });
  const counts: Record<SendOutState, number> = { awaiting: 0, overdue: 0, 'on-time': 0, late: 0, cancelled: 0 };
  for (const r of rows) counts[r.state]++;
  const rank: Record<SendOutState, number> = { overdue: 0, awaiting: 1, late: 2, 'on-time': 3, cancelled: 4 };
  const shown = rows
    .filter((r) => (opts.state ? r.state === opts.state : r.state !== 'cancelled'))
    .sort((a, b) => rank[a.state] - rank[b.state] || (a.state === 'overdue' || a.state === 'awaiting' ? a.dueAt.getTime() - b.dueAt.getTime() : b.dispatchedAt.getTime() - a.dispatchedAt.getTime()) || a.code.localeCompare(b.code));
  const skip = opts.skip ?? 0;
  return { rows: shown.slice(skip, skip + (opts.take ?? shown.length)), total: shown.length, counts };
}

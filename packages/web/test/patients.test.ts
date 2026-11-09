import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createDb, uuidv7, type Db } from '@lis/db';
import { deltaFor, samePerson, verifyAuditChain, type HistoryResult } from '@lis/lab';
import { createApp, createUser } from '@lis/web';
import { pino } from 'pino';
import { cumulative } from '../src/cumulative.js';
import { Browser, PW } from './browser.js';

const h = (over: Partial<HistoryResult>): HistoryResult => ({
  resultId: uuidv7(), orderId: 'o', hmisOrderId: 'ORD', test: 'K', status: 'sent', at: new Date('2026-11-03T08:00:00Z'), collected: true,
  value: { kind: 'numeric', value: '4.2', scale: 1 }, units: 'mmol/L', abnormalFlags: [], criticalFlag: null, deltaFlag: null, mrn: 'MRN1', ...over,
});

describe('cumulative', () => {
  it('puts collections in columns, newest first, and tests in rows', () => {
    const c = cumulative([
      h({ test: 'NA', at: new Date('2026-11-03T08:00:20Z'), value: { kind: 'numeric', value: '140', scale: 0 } }),
      h({ at: new Date('2026-11-03T08:00:00Z') }),
      h({ at: new Date('2026-11-04T09:00:00Z'), status: 'received', criticalFlag: 'HIGH', abnormalFlags: ['H'] }),
    ]);
    expect(c.columns.map((x) => x.label)).toEqual(['2026-11-04 09:00 UTC', '2026-11-03 08:00 UTC']);
    expect(c.rows.map((r) => r.test)).toEqual(['K', 'NA']);
    expect(c.rows[0]!.cells[0]![0]).toMatchObject({ value: '4.2', approved: false, critical: 'HIGH', flags: 'H' });
    expect(c.rows[1]!.cells[0]).toEqual([]);
    expect(c.rows[1]!.cells[1]![0]).toMatchObject({ value: '140', approved: true });
  });
  it('keeps only the newest columns and says how many are hidden', () => {
    const many = Array.from({ length: 15 }, (_, i) => h({ at: new Date(Date.UTC(2026, 10, 1 + i)) }));
    const c = cumulative(many, 12);
    expect(c.columns).toHaveLength(12);
    expect(c.hidden).toBe(3);
    expect(c.columns[0]!.label).toBe('2026-11-15 00:00 UTC');
  });
});

const url = process.env['TEST_DATABASE_URL'];
const TABLES = 'user_session, app_user, audit_event, result_event, result_version, result, specimen, ordered_test, lab_order, patient_merge, patient, delta_rule';

describe.skipIf(!url)('patient history over HTTP', () => {
  let db: Db;
  let app: NestExpressApplication;
  let base: string;
  let n = 0;
  const as = async (username: string) => {
    const b = new Browser(base);
    expect((await b.signIn(username)).status).toBe(303);
    return b;
  };

  const add = async (patientId: string, test: string, value: string, collectedAt: Date, status = 'sent') => {
    n++;
    const orderId = uuidv7();
    const specimenId = uuidv7();
    const testId = uuidv7();
    const resultId = uuidv7();
    await db.labOrder.create({ data: { id: orderId, hmisOrderId: `ORD-${n}`, patientId, priority: 'routine', orderedAt: collectedAt, status: 'active', sourceJson: {} } });
    await db.specimen.create({ data: { id: specimenId, orderId, accessionNo: `L2611040${String(n).padStart(4, '0')}`, barcode: `B${n}`, status: 'received', collectedAt, createdBy: 'test' } });
    await db.orderedTest.create({ data: { id: testId, orderId, hmisLineId: '1', hmisTestCode: `HMIS-${test}`, localTestCode: test, status: 'collected', specimenId } });
    await db.result.create({ data: { id: resultId, orderedTestId: testId, status, selectedVersionNo: 1 } });
    await db.resultVersion.create({ data: { id: uuidv7(), resultId, versionNo: 1, kind: 'initial', value: { kind: 'numeric', value, scale: value.split('.')[1]?.length ?? 0 }, units: 'mmol/L', abnormalFlags: [], createdBy: 'system:x' } });
    return resultId;
  };

  beforeAll(async () => {
    db = createDb(url as string);
    app = await createApp(db, { secureCookies: false, twoPersonRule: true, logger: pino({ level: 'silent' }) });
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await db?.$executeRawUnsafe(`TRUNCATE ${TABLES} CASCADE`);
    await app?.close();
    await db?.$disconnect();
  });
  beforeEach(async () => {
    await db.$executeRawUnsafe(`TRUNCATE ${TABLES} CASCADE`);
    await createUser(db, { username: 'tech', displayName: 'Tech One', password: PW, roles: ['technologist'] }, 'test');
  });

  it('finds a patient and shows only their results, linked from the result page', async () => {
    const ben = uuidv7();
    const ann = uuidv7();
    await db.patient.create({ data: { id: ben, mrn: 'MRN9', familyName: 'Example', givenName: 'Ben', sex: 'M' } });
    await db.patient.create({ data: { id: ann, mrn: 'MRN10', familyName: 'Exampleton', givenName: 'Ann' } });
    const old = await add(ben, 'K', '3.9', new Date('2026-11-01T07:00:00Z'));
    const recent = await add(ben, 'K', '5.8', new Date('2026-11-03T07:00:00Z'), 'received');
    await add(ann, 'K', '9.9', new Date('2026-11-03T07:00:00Z'));

    const b = new Browser(base);
    expect((await b.signIn('tech')).status).toBe(303);
    const found = await b.get('/patients?q=examp');
    expect(found.html).toContain('EXAMPLE, Ben');
    expect(found.html).toContain('EXAMPLETON, Ann');
    expect((await b.get('/patients?q=mrn9')).location).toBe(`/patients/${ben}`);

    const page = await b.get(`/patients/${ben}`);
    expect(page.html).toContain(`href="/results/${old}"`);
    expect(page.html).toContain(`href="/results/${recent}"`);
    expect(page.html).toContain('(not approved)');
    expect(page.html).not.toContain('9.9');
    expect(page.html.indexOf('2026-11-03 07:00')).toBeLessThan(page.html.indexOf('2026-11-01 07:00'));

    expect((await b.get(`/results/${old}`)).html).toContain(`href="/patients/${ben}"`);
    expect((await b.get(`/patients/${uuidv7()}`)).status).toBe(404);
  });

  it('records a merge from the HMIS with two people, and the MRN that stays shows both histories (A-35)', async () => {
    for (const u of ['dr.a', 'dr.b']) await createUser(db, { username: u, displayName: u, password: PW, roles: ['approver'] }, 'test');
    const old = uuidv7();
    const keep = uuidv7();
    await db.patient.create({ data: { id: old, mrn: 'MRN20', familyName: 'Example', givenName: 'Ben', sex: 'M', birthDate: new Date('1980-01-01') } });
    await db.patient.create({ data: { id: keep, mrn: 'MRN21', familyName: 'Example', givenName: 'Benjamin', sex: 'M', birthDate: new Date('1980-01-01') } });
    await add(old, 'K', '3.9', new Date('2026-10-01T08:00:00Z'));
    await add(keep, 'K', '4.4', new Date('2026-11-01T08:00:00Z'));

    const tech = await as('tech');
    expect((await tech.get(`/patients/${old}`)).html).not.toContain('Record a merge');
    expect((await tech.post(`/patients/${old}/merge`, { _csrf: await tech.csrf(`/patients/${old}`), intoMrn: 'MRN21', reference: 'MR-2026-117', reason: 'duplicate registration at outpatients' })).status).toBe(403);

    const a = await as('dr.a');
    const csrf = await a.csrf(`/patients/${old}`);
    const bad = await a.post(`/patients/${old}/merge`, { _csrf: csrf, intoMrn: 'MRN99', reference: 'MR-2026-117', reason: 'duplicate registration at outpatients' });
    expect(bad.status).toBe(422);
    expect(bad.html).toContain('No patient with MRN MRN99 has come from the HMIS yet.');
    expect((await a.post(`/patients/${old}/merge`, { _csrf: csrf, intoMrn: 'MRN20', reference: 'MR-2026-117', reason: 'duplicate registration at outpatients' })).html).toContain('cannot be merged into itself');
    expect((await a.post(`/patients/${old}/merge`, { _csrf: csrf, intoMrn: 'mrn21', reference: 'MR-2026-117', reason: 'duplicate registration at outpatients' })).location).toBe(`/patients/${old}?notice=merge-proposed`);
    const waiting = (await a.get(`/patients/${old}`)).html;
    expect(waiting).toContain('The two records differ in name. Check with medical records before confirming.');
    expect(waiting).toContain('A different person must confirm.');
    const m = await db.patientMerge.findFirstOrThrow();
    expect((await a.post(`/patients/${old}/merge/${m.id}/confirm`, { _csrf: csrf, password: PW })).status).toBe(409);
    expect(await db.patient.findUniqueOrThrow({ where: { id: old } })).toMatchObject({ mergedIntoId: null });

    const b = await as('dr.b');
    const csrf2 = await b.csrf(`/patients/${old}`);
    expect((await b.post(`/patients/${old}/merge/${m.id}/confirm`, { _csrf: csrf2, password: 'wrong password!!' })).status).toBe(403);
    expect((await b.post(`/patients/${old}/merge/${m.id}/confirm`, { _csrf: csrf2, password: PW })).location).toBe(`/patients/${old}?notice=merge-confirmed`);
    expect(await db.patient.findUniqueOrThrow({ where: { id: old } })).toMatchObject({ mergedIntoId: keep });

    // The MRN that stays shows both; the merged one points to it; nothing moved.
    const kept = (await b.get(`/patients/${keep}`)).html;
    expect(kept).toContain('This history includes results under');
    expect(kept).toContain('MRN MRN20</span>');
    expect(kept).toContain('3.9');
    expect(kept).toContain('4.4');
    const gone = (await b.get(`/patients/${old}`)).html;
    expect(gone).toContain('<strong>MRN MRN20 was merged</strong>');
    expect(gone).not.toContain('Record a merge');
    expect(await db.labOrder.count({ where: { patientId: old } })).toBe(1);
    const order = await db.labOrder.findFirstOrThrow({ where: { patientId: old } });
    expect((await b.get(`/orders/${order.id}`)).html).toContain('MRN MRN20 has been merged in the HMIS.');
    expect((await samePerson(db, old)).sort()).toEqual([old, keep].sort());
    // A delta check on the MRN that stays compares with the merged MRN's earlier result too.
    await db.deltaRule.create({ data: { id: uuidv7(), localTestCode: 'K', maxAbs: '0.3', windowDays: 60, units: 'mmol/L', reference: 'test', createdBy: 'test' } });
    const keepK = (await db.result.findFirstOrThrow({ where: { orderedTest: { order: { patientId: keep } } } })).id;
    // A new order still under the merged MRN finds the earlier result recorded under the MRN that stays.
    const fresh = await add(old, 'K', '5.0', new Date('2026-11-02T08:00:00Z'), 'received');
    const d = await db.$transaction((tx) => deltaFor(tx, fresh, { kind: 'numeric', value: '5.0', scale: 1 }, 'mmol/L'));
    expect(d).toMatchObject({ flag: 'EXCEEDED', previousResultId: keepK });

    // A merged MRN is not merged again, and the one that stays cannot be merged into it.
    await expect(b.post(`/patients/${keep}/merge`, { _csrf: csrf2, intoMrn: 'MRN20', reference: 'MR-2026-118', reason: 'merge the wrong way round' }).then((r) => r.html)).resolves.toContain('was itself merged');
    expect(await db.auditEvent.count({ where: { action: { in: ['patient.merge-proposed', 'patient.merged'] } } })).toBe(2);
    expect((await verifyAuditChain(db)).ok).toBe(true);
  });

  it('undoes a confirmed merge with two people, and each MRN has its own history again (A-39)', async () => {
    for (const u of ['dr.a', 'dr.b']) await createUser(db, { username: u, displayName: u, password: PW, roles: ['approver'] }, 'test');
    const old = uuidv7();
    const keep = uuidv7();
    await db.patient.create({ data: { id: old, mrn: 'MRN30', familyName: 'Example', givenName: 'Ben', sex: 'M' } });
    await db.patient.create({ data: { id: keep, mrn: 'MRN31', familyName: 'Example', givenName: 'Bea', sex: 'F' } });
    await add(old, 'K', '3.9', new Date('2026-10-01T08:00:00Z'));
    await add(keep, 'K', '4.4', new Date('2026-11-01T08:00:00Z'));
    const a = await as('dr.a');
    const b = await as('dr.b');
    const ca = await a.csrf(`/patients/${old}`);
    const cb = await b.csrf(`/patients/${old}`);
    await a.post(`/patients/${old}/merge`, { _csrf: ca, intoMrn: 'MRN31', reference: 'MR-2026-200', reason: 'thought to be a duplicate registration' });
    const m = await db.patientMerge.findFirstOrThrow();
    await b.post(`/patients/${old}/merge/${m.id}/confirm`, { _csrf: cb, password: PW });

    // A technologist cannot undo; a reason is required; nothing changes until a second person confirms.
    const tech = await as('tech');
    expect((await tech.get(`/patients/${old}`)).html).not.toContain('Undo this merge');
    expect((await tech.post(`/patients/${old}/merge/${m.id}/undo`, { _csrf: await tech.csrf(`/patients/${old}`), reference: 'MR-2026-201', reason: 'two different people' })).status).toBe(403);
    expect((await a.get(`/patients/${old}`)).html).toContain('Undo this merge');
    const bad = await a.post(`/patients/${old}/merge/${m.id}/undo`, { _csrf: ca, reference: 'MR-2026-201', reason: 'no' });
    expect(bad.status).toBe(422);
    expect(bad.html).toContain('Say why, in 10 to 500 characters');
    expect((await a.post(`/patients/${old}/merge/${m.id}/undo`, { _csrf: ca, reference: 'MR-2026-201', reason: 'two different people, reversed by medical records' })).location).toBe(`/patients/${old}?notice=unmerge-proposed`);
    expect((await a.get(`/patients/${old}`)).html).toContain('A different person must confirm.');
    expect((await a.post(`/patients/${old}/merge/${m.id}/undo/confirm`, { _csrf: ca, password: PW })).status).toBe(409);
    expect((await samePerson(db, old)).sort()).toEqual([old, keep].sort());

    // Withdrawing keeps the merge; proposing again and confirming undoes it.
    expect((await b.post(`/patients/${old}/merge/${m.id}/undo/withdraw`, { _csrf: cb })).location).toBe(`/patients/${old}?notice=unmerge-withdrawn`);
    expect(await db.patientMerge.findUniqueOrThrow({ where: { id: m.id } })).toMatchObject({ status: 'CONFIRMED', undoProposedBy: null });
    await a.post(`/patients/${old}/merge/${m.id}/undo`, { _csrf: ca, reference: 'MR-2026-201', reason: 'two different people, reversed by medical records' });
    expect((await b.post(`/patients/${old}/merge/${m.id}/undo/confirm`, { _csrf: cb, password: 'wrong password!!' })).status).toBe(403);
    expect((await b.post(`/patients/${old}/merge/${m.id}/undo/confirm`, { _csrf: cb, password: PW })).location).toBe(`/patients/${old}?notice=unmerge-confirmed`);
    expect(await db.patient.findUniqueOrThrow({ where: { id: old } })).toMatchObject({ mergedIntoId: null });
    expect(await db.patientMerge.findUniqueOrThrow({ where: { id: m.id } })).toMatchObject({ status: 'UNDONE', undoneBy: 'dr.b', undoProposedBy: 'dr.a' });
    expect(await samePerson(db, old)).toEqual([old]);
    expect(await samePerson(db, keep)).toEqual([keep]);

    const kept = (await b.get(`/patients/${keep}`)).html;
    expect(kept).not.toContain('This history includes results under');
    expect(kept).not.toContain('3.9');
    expect(kept).toContain('A merge of MRN MRN30 into MRN MRN31 was undone');
    const own = (await b.get(`/patients/${old}`)).html;
    expect(own).not.toContain('was merged</strong>');
    expect(own).toContain('Record a merge');
    // The undone merge does not stop a later, correct merge of the same MRN.
    expect((await a.post(`/patients/${old}/merge`, { _csrf: ca, intoMrn: 'MRN31', reference: 'MR-2026-300', reason: 'checked again with medical records' })).location).toBe(`/patients/${old}?notice=merge-proposed`);
    // The database itself refuses an undo confirmed by the person who proposed it.
    await expect(db.patientMerge.update({ where: { id: m.id }, data: { undoneBy: 'dr.a' } })).rejects.toThrow(/patient_merge_undo_chk/);
    expect((await db.auditEvent.findMany({ where: { action: { startsWith: 'patient.unmerge' } }, orderBy: { at: 'asc' } })).map((e) => e.action)).toEqual(['patient.unmerge-proposed', 'patient.unmerge-withdrawn', 'patient.unmerge-proposed', 'patient.unmerged']);
    expect((await verifyAuditChain(db)).ok).toBe(true);
  });
});

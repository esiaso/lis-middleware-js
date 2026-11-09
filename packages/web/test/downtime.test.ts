import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createDb, uuidv7, type Db } from '@lis/db';
import { approve, judgeCandidates, release, review, verifyAuditChain, WorkflowRejected, type ReconciliationCandidate } from '@lis/lab';
import { createApp, createUser } from '@lis/web';
import { pino } from 'pino';
import { Browser, PW } from './browser.js';

const url = process.env['TEST_DATABASE_URL'];
const TABLES =
  'user_session, app_user, audit_event, delivery_attempt, outbox_message, result_event, result_version, result, unmatched_result, specimen, ordered_test, lab_order, patient, hmis_code_map, test_mapping_set, instrument';

describe.skipIf(!url)('downtime registration and reconciliation over HTTP', () => {
  let db: Db;
  let app: NestExpressApplication;
  let base: string;
  const as = async (username: string) => {
    const b = new Browser(base);
    expect((await b.signIn(username)).status).toBe(303);
    return b;
  };

  beforeAll(async () => {
    db = createDb(url as string);
    app = await createApp(db, { secureCookies: false, logger: pino({ level: 'silent' }) });
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await app?.close();
    await db?.$disconnect();
  });

  beforeEach(async () => {
    await db.$executeRawUnsafe(`TRUNCATE ${TABLES} CASCADE`);
    for (const [username, roles] of [['phleb', ['operator']], ['tech', ['technologist']], ['dr', ['approver']]] as const) {
      await createUser(db, { username, displayName: username, password: PW, roles: [...roles] }, 'test');
    }
    await db.hmisCodeMap.createMany({ data: [{ hmisTestCode: 'H-TSH', localTestCode: 'TSH' }, { hmisTestCode: 'H-FT4', localTestCode: 'FT4' }] });
  });

  const form = { familyName: 'Example', givenName: 'Cara', birthDate: '1990-03-04', sex: 'F', claimedMrn: 'MRN9', location: 'Ward 3', priority: 'stat', specimenType: 'serum' };

  async function hmisOrder(lines: string[]): Promise<string> {
    const patient = await db.patient.upsert({ where: { mrn: 'MRN9' }, update: {}, create: { id: uuidv7(), mrn: 'MRN9', familyName: 'Example', givenName: 'Cara', birthDate: new Date('1990-03-04'), sex: 'F' } });
    const id = uuidv7();
    await db.labOrder.create({ data: { id, hmisOrderId: `ORD-${lines.length}`, patientId: patient.id, priority: 'stat', orderedAt: new Date(), status: 'active', sourceJson: {} } });
    await db.orderedTest.createMany({ data: lines.map((code, i) => ({ id: uuidv7(), orderId: id, hmisLineId: String(i + 1), hmisTestCode: `H-${code}`, localTestCode: code, specimenType: 'serum', status: 'active' })) });
    return id;
  }

  it('registers a provisional order, holds its results, then moves everything onto the HMIS order', async () => {
    const phleb = await as('phleb');
    const page = await phleb.get('/downtime/new');
    expect(page.html).toContain('value="TSH"');
    const csrf = await phleb.csrf('/downtime/new');
    const none = await phleb.post('/downtime', { _csrf: csrf, ...form });
    expect(none.status).toBe(422);
    expect(none.html).toContain('Choose at least one test.');
    expect(none.html).toContain('value="Example"'); // what was typed is kept
    expect((await phleb.post('/downtime', { _csrf: csrf, ...form, tests: ['GLU'] })).html).toContain('Not in the test list: GLU.');

    const reg = await phleb.post('/downtime', { _csrf: csrf, ...form, tests: ['TSH', 'FT4'] });
    const dt = await db.labOrder.findFirstOrThrow({ where: { source: 'MANUAL_DOWNTIME' }, include: { patient: true, tests: true } });
    expect(reg.location).toBe(`/orders/${dt.id}?notice=downtime-registered`);
    expect(dt).toMatchObject({ hmisOrderId: 'DT-000001', priority: 'stat', status: 'active', location: 'Ward 3' });
    expect(dt.patient).toMatchObject({ mrn: 'PROV-000001', provisional: true, familyName: 'Example' });
    expect((await phleb.get(`/orders/${dt.id}`)).html).toContain('Results are held from the HMIS');
    expect((await phleb.get('/orders')).html).toContain('downtime');

    // Collect and label as usual; a result arrives, is reviewed and approved, but cannot be released.
    await phleb.post(`/orders/${dt.id}/collect`, { _csrf: csrf, testIds: dt.tests.map((t) => t.id) });
    const specimen = await db.specimen.findFirstOrThrow({ where: { orderId: dt.id } });
    const tsh = dt.tests.find((t) => t.localTestCode === 'TSH')!;
    const resultId = uuidv7();
    await db.result.create({ data: { id: resultId, orderedTestId: tsh.id, status: 'received', selectedVersionNo: 1 } });
    await db.resultVersion.create({ data: { id: uuidv7(), resultId, versionNo: 1, kind: 'manual', value: { kind: 'numeric', value: '3.00', scale: 2 }, units: 'uIU/mL', abnormalFlags: [], createdBy: 'tech' } });
    await review(db, resultId, 'tech', 1);
    await approve(db, resultId, 'dr', { twoPersonRule: true });
    await expect(release(db, resultId, { username: 'dr', displayName: 'dr' })).rejects.toBeInstanceOf(WorkflowRejected);
    const dr = await as('dr');
    const rp = await dr.get(`/results/${resultId}`);
    expect(rp.html).toContain('held from the HMIS');
    expect(rp.html).not.toContain('Release to HMIS');
    // The worklist and the dashboard show what is waiting.
    const waiting = (await dr.get('/downtime')).html;
    expect(waiting).toContain('<span class="badge text-bg-warning">1 approved</span>');
    expect(waiting).toContain('no HMIS order matches yet');
    expect((await dr.get('/')).html).toContain('1 downtime order to reconcile');

    // The HMIS order arrives without FT4: shown, but cannot be chosen.
    const partial = await hmisOrder(['TSH']);
    const tech = await as('tech');
    const rec = await tech.get(`/downtime/${dt.id}`);
    expect(rec.html).toContain('EXAMPLE, Cara · MRN MRN9');
    expect(rec.html).toContain('Not ordered in the HMIS: FT4');
    expect((await tech.get('/downtime')).html).toContain('ORD-1 has no FT4; ask for it to be ordered in the HMIS');
    const tcsrf = await tech.csrf(`/downtime/${dt.id}`);
    expect((await tech.post(`/downtime/${dt.id}/reconcile`, { _csrf: tcsrf, hmisOrderId: partial, password: PW })).html).toContain('has no free FT4');

    const full = await hmisOrder(['TSH', 'FT4', 'PRL']);
    const suggested = (await tech.get(`/downtime/${dt.id}`)).html;
    expect(suggested).toContain('MRN, birth date, family name, given name, tests');
    expect(suggested).toContain('Suggested: <span class="font-monospace">ORD-3</span>');
    const list = (await tech.get('/downtime')).html;
    expect(list).toContain('<span class="badge text-bg-success">clear</span>');
    expect(list).toContain('1 has a clear match.');
    expect((await tech.post(`/downtime/${dt.id}/reconcile`, { _csrf: tcsrf, hmisOrderId: full, password: 'not my password' })).status).toBe(403);
    const pcsrf = await phleb.csrf('/downtime');
    expect((await phleb.post(`/downtime/${dt.id}/reconcile`, { _csrf: pcsrf, hmisOrderId: full, password: PW })).status).toBe(403);

    const done = await tech.post(`/downtime/${dt.id}/reconcile`, { _csrf: tcsrf, hmisOrderNo: 'ORD-3', password: PW });
    expect(done.location).toBe(`/orders/${full}?notice=reconciled`);
    expect(await db.specimen.findUniqueOrThrow({ where: { id: specimen.id } })).toMatchObject({ orderId: full, accessionNo: specimen.accessionNo });
    const moved = await db.result.findUniqueOrThrow({ where: { id: resultId }, include: { orderedTest: true } });
    expect(moved.orderedTest).toMatchObject({ orderId: full, localTestCode: 'TSH', hmisLineId: '1', specimenId: specimen.id });
    expect(await db.orderedTest.count({ where: { orderId: full, specimenId: specimen.id } })).toBe(2);
    expect(await db.orderedTest.count({ where: { orderId: full, localTestCode: 'PRL', specimenId: null } })).toBe(1);
    expect(await db.labOrder.findUniqueOrThrow({ where: { id: dt.id } })).toMatchObject({ status: 'reconciled', reconciledToId: full, reconciledBy: 'tech' });
    const prov = await db.patient.findUniqueOrThrow({ where: { mrn: 'PROV-000001' } });
    expect(prov.mergedIntoId).toBe((await db.labOrder.findUniqueOrThrow({ where: { id: full } })).patientId);
    expect((await tech.post(`/downtime/${dt.id}/reconcile`, { _csrf: tcsrf, hmisOrderId: full, password: PW })).html).toContain('already reconciled');
    expect((await tech.get(`/specimens/${specimen.id}`)).html).toContain('Downtime order reconciled by tech');
    expect((await tech.get('/downtime')).html).toContain('Nothing to reconcile.');
    expect((await tech.get('/')).html).not.toContain('downtime order to reconcile');

    // Release now goes out against the HMIS order and line.
    await release(db, resultId, { username: 'dr', displayName: 'dr' });
    const out = await db.outboxMessage.findFirstOrThrow({ where: { resultId } });
    expect(out.payload).toMatchObject({ hmisOrderId: 'ORD-3', hmisLineId: '1', testCode: 'H-TSH', specimen: { accessionNo: specimen.accessionNo } });
    expect((await verifyAuditChain(db)).ok).toBe(true);
  });

  it('numbers downtime orders in sequence and lists them', async () => {
    const phleb = await as('phleb');
    const csrf = await phleb.csrf('/downtime/new');
    await phleb.post('/downtime', { _csrf: csrf, familyName: 'One', tests: 'TSH' });
    await phleb.post('/downtime', { _csrf: csrf, familyName: 'Two', tests: 'FT4' });
    const list = await phleb.get('/downtime');
    expect(list.html).toContain('DT-000001');
    expect(list.html).toContain('DT-000002');
    expect(list.html).toContain('Reconcile');
    const aud = await db.auditEvent.count({ where: { action: 'order.downtime-registered' } });
    expect(aud).toBe(2);
  });
});

describe('suggesting the HMIS order for a downtime order', () => {
  const c = (hmisOrderId: string, score: number, why: string[], missing: string[] = []): ReconciliationCandidate => ({
    orderId: hmisOrderId, hmisOrderId, orderedAt: new Date('2026-11-05T08:00:00Z'), score, why, missing,
    patient: { mrn: `M-${hmisOrderId}`, familyName: 'Example', givenName: 'Cara', birthDate: null, sex: null },
  });
  it('is clear only for a strong match with every test and no close rival', () => {
    expect(judgeCandidates([])).toMatchObject({ suggestion: 'none' });
    expect(judgeCandidates([c('A', 9, ['MRN', 'birth date', 'family name', 'tests'])])).toMatchObject({ suggestion: 'clear', note: 'matches on MRN, birth date, family name, tests' });
    expect(judgeCandidates([c('A', 5, ['birth date', 'family name', 'tests'])])).toMatchObject({ suggestion: 'clear' });
    expect(judgeCandidates([c('A', 3, ['family name', 'tests'])])).toMatchObject({ suggestion: 'check', note: 'matches only on family name, tests' });
    expect(judgeCandidates([c('A', 5, ['birth date', 'family name', 'tests']), c('B', 4, ['birth date', 'family name'])])).toMatchObject({ suggestion: 'check', note: 'A and B match about equally' });
    expect(judgeCandidates([c('A', 9, ['MRN', 'birth date', 'family name']), c('B', 5, ['birth date', 'family name', 'tests'])].map((x, i) => (i === 0 ? { ...x, missing: ['FT4'] } : x)))).toMatchObject({ suggestion: 'check', best: { hmisOrderId: 'B' }, note: 'A matches as well but has no FT4' });
    expect(judgeCandidates([c('A', 8, ['MRN'], ['FT4'])])).toMatchObject({ suggestion: 'not-ordered', note: 'A has no FT4; ask for it to be ordered in the HMIS' });
  });
});

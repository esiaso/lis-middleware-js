import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createDb, uuidv7, type Db } from '@lis/db';
import { approveCatalogueEntry, proposeCatalogueEntry } from '@lis/lab';
import { createApp, createUser } from '@lis/web';
import { pino } from 'pino';
import { Browser, PW } from './browser.js';

const url = process.env['TEST_DATABASE_URL'];
const TABLES =
  'user_session, app_user, audit_event, delivery_attempt, outbox_message, critical_call, result_event, result_comment, result_version, result, unmatched_result, specimen, ordered_test, lab_order, patient, hmis_code_map, test_catalogue, manual_qc';

// Example codes and answers for the test; the lab chooses its own.
const DIPSTICK = {
  localCode: 'u-prot', name: 'Urine protein (dipstick)', section: 'Urinalysis', loincCode: '', loincDisplay: '', shaCode: '', specimenType: 'Urine',
  performedBy: 'MANUAL', resultType: 'ORDINAL', answers: 'NEG | Negative\nTR | Trace\n1P | 1+ | abnormal', unit: '', decimals: '', reason: 'new bench test',
};

describe.skipIf(!url)('test catalogue and manual worksheet over HTTP', () => {
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
    await createUser(db, { username: 'manager', displayName: 'Lab Manager', password: PW, roles: ['admin'] }, 'test');
    await createUser(db, { username: 'dr.lab', displayName: 'Dr Lab', password: PW, roles: ['approver'] }, 'test');
  });

  it('a draft from one person is approved by another, and a technologist cannot change the catalogue', async () => {
    const tech = await as('tech');
    expect((await tech.get('/catalogue')).html).toContain('No tests in the catalogue yet.');
    expect((await tech.post('/catalogue', { ...DIPSTICK, _csrf: await tech.csrf('/catalogue') })).status).toBe(403);

    const mgr = await as('manager');
    const csrf = await mgr.csrf('/catalogue');
    const bad = await mgr.post('/catalogue', { ...DIPSTICK, _csrf: csrf, loincCode: '5804-1' });
    expect(bad.status).toBe(422);
    expect(bad.html).toContain('5804-1 fails the LOINC check digit');
    expect((await mgr.post('/catalogue', { ...DIPSTICK, _csrf: csrf })).location).toBe('/catalogue?notice=catalogue-proposed');
    const draft = await db.testCatalogueEntry.findFirstOrThrow();
    expect((await mgr.get('/catalogue')).html).toContain('Another person approves this.');
    expect((await mgr.post(`/catalogue/${draft.id}/approve`, { _csrf: csrf, password: PW })).status).toBe(409);

    const dr = await as('dr.lab');
    const c2 = await dr.csrf('/catalogue');
    expect((await dr.post(`/catalogue/${draft.id}/approve`, { _csrf: c2, password: 'wrong' })).status).toBe(403);
    expect((await dr.post(`/catalogue/${draft.id}/approve`, { _csrf: c2, password: PW })).location).toBe('/catalogue?notice=catalogue-approved');
    const page = (await dr.get('/catalogue')).html;
    expect(page).toContain('Urine protein (dipstick)');
    expect(page).toContain('1+ *');
    // Changing it starts from the active version.
    expect((await dr.get('/catalogue?edit=U-PROT')).location).toBe('/catalogue/U-PROT/edit');
    const edit = (await dr.get('/catalogue/U-PROT/edit')).html;
    expect(edit).toContain('name="answer-2-code" value="1P"');
    expect(edit).toMatch(/name="answer-2-flag"[^>]*>.*<option value="abnormal" selected>/s);
    expect((await dr.get('/catalogue/NOPE/edit')).status).toBe(404);
    expect((await tech.get('/catalogue/new')).status).toBe(403);
  });

  it('the answer rows are saved as the answer list, and the list can be filtered', async () => {
    const mgr = await as('manager');
    const { answers: _answers, ...rest } = DIPSTICK;
    const rows = {
      'answer-0-code': 'NEG', 'answer-0-display': 'Negative', 'answer-0-flag': '', 'answer-0-la': '',
      'answer-1-code': '', 'answer-1-display': '', 'answer-1-flag': '', 'answer-1-la': '',
      'answer-2-code': '3P', 'answer-2-display': '3+', 'answer-2-flag': 'critical', 'answer-2-la': '',
    };
    expect((await mgr.post('/catalogue', { ...rest, ...rows, _csrf: await mgr.csrf('/catalogue') })).location).toBe('/catalogue?notice=catalogue-proposed');
    const draft = await db.testCatalogueEntry.findFirstOrThrow();
    expect(draft.answers).toEqual([{ code: 'NEG', display: 'Negative' }, { code: '3P', display: '3+', abnormal: true, critical: true }]);
    const one = await mgr.post('/catalogue', { ...rest, 'answer-0-code': 'NEG', 'answer-0-display': 'Negative', _csrf: await mgr.csrf('/catalogue') });
    expect(one.status).toBe(422);
    expect(one.html).toContain('A choice result needs at least two answers');
    expect(one.html).toContain('name="answer-0-code" value="NEG"');

    const dr = await as('dr.lab');
    await dr.post(`/catalogue/${draft.id}/approve`, { _csrf: await dr.csrf('/catalogue'), password: PW });
    expect((await dr.get('/catalogue?q=prot')).html).toContain('Urine protein (dipstick)');
    const none = (await dr.get('/catalogue?q=zzz')).html;
    expect(none).toContain('No tests match.');
    expect(none).not.toContain('Urine protein (dipstick)');
    expect((await dr.get('/catalogue?by=INSTRUMENT')).html).toContain('No tests match.');
  });

  it('a technologist enters a manual result on the worksheet, and it shows who performed it', async () => {
    const mgr = await as('manager');
    await mgr.post('/catalogue', { ...DIPSTICK, _csrf: await mgr.csrf('/catalogue') });
    const dr = await as('dr.lab');
    await dr.post(`/catalogue/${(await db.testCatalogueEntry.findFirstOrThrow()).id}/approve`, { _csrf: await dr.csrf('/catalogue'), password: PW });

    const patientId = uuidv7();
    const orderId = uuidv7();
    const specimenId = uuidv7();
    const testId = uuidv7();
    await db.patient.create({ data: { id: patientId, mrn: 'MRN7', familyName: 'Example', givenName: 'Ann', sex: 'F' } });
    await db.labOrder.create({ data: { id: orderId, hmisOrderId: 'ORD-7', patientId, priority: 'stat', orderedAt: new Date(), status: 'active', location: 'Ward 3', sourceJson: {} } });
    await db.specimen.create({ data: { id: specimenId, orderId, accessionNo: 'L26110500007', barcode: 'L26110500007', status: 'received', receivedAt: new Date(), createdBy: 'test' } });
    await db.orderedTest.create({ data: { id: testId, orderId, hmisLineId: '1', hmisTestCode: 'HMIS-UPROT', localTestCode: 'U-PROT', status: 'active', specimenId } });

    const tech = await as('tech');
    const sheet = (await tech.get('/worksheet')).html;
    expect(sheet).toContain('L26110500007');
    expect(sheet).toContain('STAT');
    expect(sheet).toContain('1+ (abnormal)');
    const csrf = await tech.csrf('/worksheet');
    const empty = await tech.post(`/worksheet/${testId}`, { _csrf: csrf, value: '', performedBy: '', lot: '' });
    expect(empty.status).toBe(422);
    expect(empty.html).toContain('An empty field is never taken as normal.');
    expect((await tech.post(`/worksheet/${testId}`, { _csrf: csrf, value: '1P', performedBy: 'Tech Two', lot: 'STRIP-44', section: 'Urinalysis' })).location).toBe('/worksheet?notice=manual-entered&section=Urinalysis');
    expect((await tech.get('/worksheet')).html).toContain('No received specimens are waiting for a manual test.');

    const r = await db.result.findFirstOrThrow();
    const detail = (await tech.get(`/results/${r.id}`)).html;
    expect(detail).toContain('manual entry: performed by Tech Two, lot STRIP-44, entered by tech');
    expect(detail).toContain('1+ (1P)');
  });

  it('a critical answer is marked on the catalogue and worksheet, and waits on the critical page for a call (A-36)', async () => {
    const d = await proposeCatalogueEntry(db, 'manager', { ...DIPSTICK, answers: 'NEG | Negative\nTR | Trace\n3P | 3+ | critical' }, 'example');
    await approveCatalogueEntry(db, 'dr.lab', d.id);
    const orderId = uuidv7();
    const testId = uuidv7();
    const patientId = uuidv7();
    await db.patient.create({ data: { id: patientId, mrn: 'MRN8', familyName: 'Example', givenName: 'Bo', sex: 'M' } });
    await db.labOrder.create({ data: { id: orderId, hmisOrderId: 'ORD-8', patientId, priority: 'routine', orderedAt: new Date(), status: 'active', sourceJson: {} } });
    const specimenId = uuidv7();
    await db.specimen.create({ data: { id: specimenId, orderId, accessionNo: 'L26110900008', barcode: 'L26110900008', status: 'received', receivedAt: new Date(), createdBy: 'test' } });
    await db.orderedTest.create({ data: { id: testId, orderId, hmisLineId: '1', hmisTestCode: 'HMIS-UPROT', localTestCode: 'U-PROT', status: 'active', specimenId } });

    const tech = await as('tech');
    expect((await tech.get('/catalogue')).html).toContain('3+ <strong>!</strong>');
    expect((await tech.get('/worksheet')).html).toContain('3+ (critical)');
    await tech.post(`/worksheet/${testId}`, { _csrf: await tech.csrf('/worksheet'), value: '3P', performedBy: '', lot: '' });
    const r = await db.result.findFirstOrThrow();
    const detail = (await tech.get(`/results/${r.id}`)).html;
    expect(detail).toContain('critical answer');
    expect(detail).toContain('3+ is a critical answer for U-PROT (catalogue version 1)');
    const waiting = (await tech.get('/critical')).html;
    expect(waiting).toContain('critical answer');
    expect(waiting).toContain('MRN8');
    expect((await tech.get('/')).html).toContain('1 critical result not yet called');
  });

  it('a panel is entered on one card, and a component left empty stays for later', async () => {
    const add = async (f: Record<string, string>) => approveCatalogueEntry(db, 'dr.lab', (await proposeCatalogueEntry(db, 'manager', { ...DIPSTICK, ...f } as never, 'urinalysis bench')).id);
    await add({ localCode: 'U-PROT' });
    await add({ localCode: 'U-RBC', name: 'Urine RBC per HPF', resultType: 'NUMERIC', answers: '', unit: '/[HPF]', decimals: '0' });
    await add({ localCode: 'UA', name: 'Urinalysis', resultType: 'PANEL', answers: '', components: 'U-PROT U-RBC' });

    const patientId = uuidv7();
    const orderId = uuidv7();
    const specimenId = uuidv7();
    const prot = uuidv7();
    const rbc = uuidv7();
    await db.patient.create({ data: { id: patientId, mrn: 'MRN8', familyName: 'Example' } });
    await db.labOrder.create({ data: { id: orderId, hmisOrderId: 'ORD-8', patientId, priority: 'routine', orderedAt: new Date(), status: 'active', sourceJson: {} } });
    await db.specimen.create({ data: { id: specimenId, orderId, accessionNo: 'L26110500008', barcode: 'L26110500008', status: 'received', receivedAt: new Date(), createdBy: 'test' } });
    for (const [id, code] of [[prot, 'U-PROT'], [rbc, 'U-RBC']] as const) {
      await db.orderedTest.create({ data: { id, orderId, hmisLineId: '1', hmisTestCode: 'HMIS-UA', localTestCode: code, componentCode: code, panelCode: 'UA', status: 'active', specimenId } });
    }
    const tech = await as('tech');
    const sheet = (await tech.get('/worksheet')).html;
    expect(sheet.match(/action="\/worksheet\/panel"/g)).toHaveLength(1);
    expect(sheet).toContain('Urinalysis');
    expect(sheet).toContain('Urine RBC per HPF');
    const csrf = await tech.csrf('/worksheet');
    const bad = await tech.post('/worksheet/panel', { _csrf: csrf, [`value-${prot}`]: '1P', [`value-${rbc}`]: '2.5', performedBy: '', lot: 'S-1' });
    expect(bad.status).toBe(422);
    expect(bad.html).toContain('U-RBC: Urine RBC per HPF is reported with no decimals.');
    expect(await db.result.count()).toBe(0);
    expect((await tech.post('/worksheet/panel', { _csrf: csrf, [`value-${prot}`]: '1P', [`value-${rbc}`]: '', performedBy: '', lot: 'S-1' })).location).toBe('/worksheet?notice=manual-entered');
    expect(await db.result.count()).toBe(1);
    const after = (await tech.get('/worksheet')).html;
    expect(after).toContain('Urine RBC per HPF');
    expect(after).not.toContain(`value-${prot}`);
  });

  it('a test that needs QC is refused on the worksheet until a control on the lot passes (A-33)', async () => {
    const mgr = await as('manager');
    const bad = await mgr.post('/catalogue', { ...DIPSTICK, performedBy: 'INSTRUMENT', qcRule: 'BLOCK', qcValidHours: '', _csrf: await mgr.csrf('/catalogue') });
    expect(bad.status).toBe(422);
    expect(bad.html).toContain('the QC rule here is for tests read by a person');
    await mgr.post('/catalogue', { ...DIPSTICK, qcRule: 'BLOCK', qcValidHours: '24', _csrf: await mgr.csrf('/catalogue') });
    const dr = await as('dr.lab');
    await dr.post(`/catalogue/${(await db.testCatalogueEntry.findFirstOrThrow()).id}/approve`, { _csrf: await dr.csrf('/catalogue'), password: PW });
    expect((await dr.get('/catalogue')).html).toContain('blocks without a passing control for the lot, each 24 h');

    const patientId = uuidv7();
    const orderId = uuidv7();
    const specimenId = uuidv7();
    const testId = uuidv7();
    await db.patient.create({ data: { id: patientId, mrn: 'MRN8', familyName: 'Example', givenName: 'Ben', sex: 'M' } });
    await db.labOrder.create({ data: { id: orderId, hmisOrderId: 'ORD-8', patientId, priority: 'routine', orderedAt: new Date(), status: 'active', sourceJson: {} } });
    await db.specimen.create({ data: { id: specimenId, orderId, accessionNo: 'L26110500008', barcode: 'L26110500008', status: 'received', receivedAt: new Date(), createdBy: 'test' } });
    await db.orderedTest.create({ data: { id: testId, orderId, hmisLineId: '1', hmisTestCode: 'HMIS-UPROT', localTestCode: 'U-PROT', status: 'active', specimenId } });

    const tech = await as('tech');
    const sheet = (await tech.get('/worksheet')).html;
    expect(sheet).toContain('no lot of U-PROT has a passing control');
    expect(sheet).toContain('A result is refused without one.');
    const csrf = await tech.csrf('/worksheet');
    const refused = await tech.post(`/worksheet/${testId}`, { _csrf: csrf, value: 'NEG', performedBy: '', lot: 'STRIP-50' });
    expect(refused.status).toBe(422);
    expect(refused.html).toContain('QC for U-PROT lot STRIP-50 has no control recorded. Run and record the control on the manual QC page first.');

    // The form for a choice test offers its answers, and the outcome follows from them.
    const qcPage = (await tech.get('/worksheet/qc?test=U-PROT')).html;
    expect(qcPage).toContain('Passes when the control reads what it should.');
    const qcCsrf = await tech.csrf('/worksheet/qc');
    const empty = await tech.post('/worksheet/qc', { _csrf: qcCsrf, localCode: 'U-PROT', lot: 'STRIP-50', lotExpiry: '', control: 'positive control', expected: '1P', observed: '', outcome: '', performedBy: '', comment: '' });
    expect(empty.status).toBe(422);
    expect(empty.html).toContain('An empty field is never taken as a pass.');
    const ok = await tech.post('/worksheet/qc', { _csrf: qcCsrf, localCode: 'U-PROT', lot: 'STRIP-50', lotExpiry: '2099-01-31', control: 'positive control', expected: '1P', observed: '1P', outcome: '', performedBy: '', comment: '' });
    expect(ok.location).toBe('/worksheet/qc?notice=manual-qc-recorded&test=U-PROT');
    const after = (await tech.get('/worksheet/qc')).html;
    expect(after).toContain('expires 2099-01-31');
    expect(after).toContain('<span class="badge text-bg-success">Pass</span>');
    expect((await tech.get('/worksheet')).html).toContain('lots with a passing control now <span class="badge text-bg-success ms-1 font-monospace">STRIP-50</span>');

    expect((await tech.post(`/worksheet/${testId}`, { _csrf: csrf, value: 'NEG', performedBy: '', lot: 'STRIP-50' })).status).toBe(303);
    const r = await db.result.findFirstOrThrow();
    expect((await tech.get(`/results/${r.id}`)).html).toContain('lot STRIP-50, entered by tech · QC passed');
  });
});

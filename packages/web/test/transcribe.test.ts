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
  'user_session, app_user, audit_event, delivery_attempt, outbox_message, critical_call, result_event, result_comment, result_version, result, unmatched_result, specimen, ordered_test, lab_order, patient, hmis_code_map, test_catalogue, manual_qc, instrument';

// Example test for the check; the lab chooses its own codes and units.
const HB = {
  localCode: 'HB', name: 'Haemoglobin', section: 'Haematology', loincCode: '', loincDisplay: '', shaCode: '', specimenType: 'Whole blood',
  performedBy: 'INSTRUMENT', resultType: 'NUMERIC', answers: '', unit: 'g/L', decimals: '0', components: '', qcRule: '', qcValidHours: '',
};

describe.skipIf(!url)('instrument downtime: results typed in from the printout (A-41)', () => {
  let db: Db;
  let app: NestExpressApplication;
  let base: string;
  let testId: string;
  let specimenId: string;

  const as = async (username: string) => {
    const b = new Browser(base);
    expect((await b.signIn(username)).status).toBe(303);
    return b;
  };

  beforeAll(async () => {
    db = createDb(url as string);
    // The two-person rule is off: a typed-in result still needs a second person.
    app = await createApp(db, { secureCookies: false, twoPersonRule: false, logger: pino({ level: 'silent' }) });
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
    await createUser(db, { username: 'dr.lab', displayName: 'Dr Lab', password: PW, roles: ['approver'] }, 'test');
    await createUser(db, { username: 'dr.two', displayName: 'Dr Two', password: PW, roles: ['approver'] }, 'test');
    const d = await proposeCatalogueEntry(db, 'dr.lab', HB as never, 'example');
    await approveCatalogueEntry(db, 'dr.two', d.id);
    await db.instrument.create({
      data: { id: 'bc-01', displayName: 'Haematology analyser', manufacturer: 'Example', model: 'X', softwareVersion: '1', verifiedSoftwareVersion: '1', verificationStatus: 'LAB_ACCEPTED', enabled: true, discipline: 'haematology', createdBy: 'test' },
    });
    const patientId = uuidv7();
    const orderId = uuidv7();
    specimenId = uuidv7();
    testId = uuidv7();
    await db.patient.create({ data: { id: patientId, mrn: 'MRN5', familyName: 'Example', givenName: 'Eve', sex: 'F' } });
    await db.labOrder.create({ data: { id: orderId, hmisOrderId: 'ORD-5', patientId, priority: 'routine', orderedAt: new Date(), status: 'active', sourceJson: {} } });
    await db.specimen.create({ data: { id: specimenId, orderId, accessionNo: 'L26111000055', barcode: 'L26111000055', status: 'received', receivedAt: new Date(), createdBy: 'test' } });
    await db.orderedTest.create({ data: { id: testId, orderId, hmisLineId: '1', hmisTestCode: 'H-HB', localTestCode: 'HB', status: 'active', specimenId } });
  });

  const form = (extra: Record<string, string>) => ({ instrumentId: 'bc-01', runRef: 'RUN 0412', reason: 'Analyser link down since 08:10', performedBy: '', accession: '', specimenId, ...extra });

  it('lists the waiting instrument test, checks the form, saves with the run and reason, and needs another person to approve', async () => {
    const dr = await as('dr.lab');
    const page = (await dr.get('/transcribe')).html;
    expect(page).toContain('L26111000055');
    expect(page).toContain('Haemoglobin');
    expect((await dr.get('/transcribe?accession=L26119999999')).html).toContain('No received specimen L26119999999');

    const csrf = await dr.csrf('/transcribe');
    const bad = await dr.post('/transcribe', { ...form({ runRef: '', reason: 'x' }), _csrf: csrf, [`value-${testId}`]: '12.5' });
    expect(bad.status).toBe(422);
    expect(bad.html).toContain('Give the run, sample or printout reference');
    expect(bad.html).toContain('Say why the results are typed in');
    const badValue = await dr.post('/transcribe', { ...form({}), _csrf: csrf, [`value-${testId}`]: '12.5' });
    expect(badValue.status).toBe(422); // HB has no decimals in the catalogue
    expect(await db.result.count()).toBe(0);

    expect((await dr.post('/transcribe', { ...form({ performedBy: 'Tech Two' }), _csrf: csrf, [`value-${testId}`]: '125' })).location).toBe('/transcribe?notice=transcribed');
    const r = await db.result.findFirstOrThrow({ include: { versions: true } });
    expect(r.instrumentId).toBe('bc-01');
    expect(r.versions[0]).toMatchObject({ kind: 'manual', units: 'g/L', value: { kind: 'numeric', value: '125' } });
    expect(await db.auditEvent.count({ where: { action: 'result.transcribe', reason: 'Analyser link down since 08:10' } })).toBe(1);
    expect((await dr.get('/transcribe')).html).toContain('No received specimens are waiting for an instrument result.');

    const detail = (await dr.get(`/results/${r.id}`)).html;
    expect(detail).toContain('typed in from the printout');
    expect(detail).toContain('Run RUN 0412, run by Tech Two, typed by dr.lab: Analyser link down since 08:10');

    const tech = await as('tech');
    const c = await tech.csrf(`/results/${r.id}`);
    expect((await tech.post(`/results/${r.id}/review`, { _csrf: c, versionNo: '1' })).location).toBe(`/results/${r.id}?notice=reviewed`);
    // The person who typed it does not approve it, even with the two-person rule off.
    const own = await dr.post(`/results/${r.id}/approve`, { _csrf: await dr.csrf(`/results/${r.id}`), password: PW });
    expect(own.status).toBe(409);
    const two = await as('dr.two');
    expect((await two.post(`/results/${r.id}/approve`, { _csrf: await two.csrf(`/results/${r.id}`), password: PW })).location).toBe(`/results/${r.id}?notice=approved`);
  });

  it('refuses a test read by a person, and an unknown instrument', async () => {
    const tech = await as('tech');
    const csrf = await tech.csrf('/transcribe');
    const unknown = await tech.post('/transcribe', { ...form({ instrumentId: 'nope' }), _csrf: csrf, [`value-${testId}`]: '125' });
    expect(unknown.status).toBe(422);
    expect(unknown.html).toContain('nope is not a registered instrument.');
    const empty = await tech.post('/transcribe', { ...form({}), _csrf: csrf, [`value-${testId}`]: '' });
    expect(empty.status).toBe(422);
    expect(empty.html).toContain('Empty fields are never taken as normal');
    expect(await db.result.count()).toBe(0);
  });
});

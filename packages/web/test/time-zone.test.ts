import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createDb, uuidv7, type Db, type JsonInput } from '@lis/db';
import { createApp, createUser } from '@lis/web';
import { pino } from 'pino';
import { Browser, PW } from './browser.js';

const url = process.env['TEST_DATABASE_URL'];
const TABLES = 'user_session, app_user, audit_event, qc_evaluation, unmatched_result, result_version, result, observation, normalized_message, specimen, ordered_test, lab_order, patient, instrument';

// Africa/Nairobi is UTC+3 all year: no daylight saving, so the expectations are fixed.
describe.skipIf(!url)('the lab time zone over HTTP', () => {
  let db: Db;
  let app: NestExpressApplication;
  let base: string;
  let orderId: string;
  let testId: string;

  const as = async (username: string) => {
    const b = new Browser(base);
    expect((await b.signIn(username)).status).toBe(303);
    return b;
  };

  beforeAll(async () => {
    db = createDb(url as string);
    await expect(createApp(db, { secureCookies: false, timeZone: 'Nairobi', logger: pino({ level: 'silent' }) })).rejects.toThrow('is not a time zone name');
    app = await createApp(db, { secureCookies: false, timeZone: 'Africa/Nairobi', logger: pino({ level: 'silent' }) });
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await app?.close();
    await db?.$disconnect();
  });
  beforeEach(async () => {
    await db.$executeRawUnsafe(`TRUNCATE ${TABLES} CASCADE`);
    await createUser(db, { username: 'phleb', displayName: 'Phleb', password: PW, roles: ['operator'] }, 'test');
    await createUser(db, { username: 'dr.lab', displayName: 'Dr Lab', password: PW, roles: ['approver', 'auditor'] }, 'test');
    const patientId = uuidv7();
    orderId = uuidv7();
    testId = uuidv7();
    await db.patient.create({ data: { id: patientId, mrn: 'MRN7', familyName: 'Example', givenName: 'Eve' } });
    await db.labOrder.create({ data: { id: orderId, hmisOrderId: 'ORD-7', patientId, priority: 'routine', orderedAt: new Date('2026-11-03T21:30:00Z'), status: 'active', sourceJson: {} } });
    await db.orderedTest.create({ data: { id: testId, orderId, hmisLineId: '1', hmisTestCode: 'H-K', localTestCode: 'K', specimenType: 'serum', status: 'active' } });
  });

  it('shows times on the lab clock and reads typed times on it', async () => {
    const b = await as('phleb');
    const order = await b.get(`/orders/${orderId}`);
    expect(order.html).toContain('Ordered 2026-11-04 00:30 GMT+3'); // 21:30 UTC the day before
    expect(order.html).toContain('Collected at (Africa/Nairobi');
    const csrf = await b.csrf(`/orders/${orderId}`);
    expect((await b.post(`/orders/${orderId}/collect`, { _csrf: csrf, testIds: [testId], collectedAt: '2026-11-04T08:10' })).status).toBe(303);
    const s = await db.specimen.findFirstOrThrow({ where: { orderId } });
    expect(s.collectedAt).toEqual(new Date('2026-11-04T05:10:00Z'));
    expect((await b.get(`/orders/${orderId}`)).html).toContain('2026-11-04 08:10 GMT+3');
  });

  it('cuts report and audit days at the lab\'s midnight', async () => {
    await db.instrument.create({ data: { id: 'c111-01', displayName: 'c 111', manufacturer: 'Roche', model: 'cobas c 111', softwareVersion: '1', verifiedSoftwareVersion: '1', verificationStatus: 'LAB_ACCEPTED', enabled: true, discipline: 'chemistry', createdBy: 'test' } });
    // 22:30 UTC on 3 November is 01:30 on 4 November in Nairobi.
    const nm = uuidv7();
    await db.normalizedMessage.create({ data: { id: nm, rawMessageId: uuidv7(), seq: 1, instrumentId: 'c111-01', adapterName: 'test', adapterVersion: '1', kind: 'result', sampleClass: 'patient', sampleId: 'S1', sampleIdReadError: false, payload: {} as JsonInput, createdAt: new Date('2026-11-03T22:30:00Z') } });
    const ob = uuidv7();
    await db.observation.create({ data: { id: ob, normalizedMessageId: nm, seq: 1, instrumentTestCode: 'K', originalValueText: '4.2', value: { kind: 'numeric', value: '4.2', scale: 1 }, units: 'mmol/L', abnormalFlags: [], mapping: 'MAPPED', localTestCode: 'K' } });
    const resultId = uuidv7();
    await db.result.create({ data: { id: resultId, orderedTestId: testId, status: 'received', selectedVersionNo: 1 } });
    await db.resultVersion.create({ data: { id: uuidv7(), resultId, versionNo: 1, kind: 'initial', value: { kind: 'numeric', value: '4.2', scale: 1 }, abnormalFlags: [], observationId: ob, createdBy: 'test' } });

    const dr = await as('dr.lab');
    const strip = (h: string) => h.replace(/<[^>]+>/g, '|').replace(/\s+/g, ' ').replace(/\|( ?\|)+/g, '|');
    expect(strip((await dr.get('/reports/workload?from=2026-11-04&to=2026-11-04')).html)).toContain('|2026-11-04|1|0|0|');
    expect((await dr.get('/reports/workload?from=2026-11-03&to=2026-11-03')).html).toContain('Nothing arrived');
    expect((await dr.get('/reports/workload.csv?from=2026-11-04&to=2026-11-04')).html).toContain('2026-11-04,c111-01,c 111,K,1,0');

    // The sign-ins above happened "today" on the Nairobi clock, whatever the UTC date.
    const day = (ms: number) => new Date(ms + 3 * 3_600_000).toISOString().slice(0, 10);
    expect((await dr.get(`/audit?action=auth.login&from=${day(Date.now())}&to=${day(Date.now())}`)).html).toContain('auth.login');
    expect((await dr.get(`/audit?action=auth.login&from=${day(Date.now() + 86_400_000)}`)).html).not.toContain('>auth.login<');
  });
});

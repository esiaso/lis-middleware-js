import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createDb, uuidv7, type Db } from '@lis/db';
import { attachObservation, pastTarget, verifyAuditChain, waitingCriticals } from '@lis/lab';
import { createApp, createUser } from '@lis/web';
import { pino } from 'pino';
import { Browser, PW } from './browser.js';

const url = process.env['TEST_DATABASE_URL'];
const TABLES =
  'user_session, app_user, audit_event, critical_call, critical_call_target, critical_limit, delivery_attempt, outbox_message, result_event, result_version, result, unmatched_result, specimen, ordered_test, lab_order, patient, instrument, hmis_code_map';

// The limit values below are made up for the test. They are not clinical guidance.
describe.skipIf(!url)('critical results over HTTP', () => {
  let db: Db;
  let app: NestExpressApplication;
  let base: string;
  let testId: string;

  const as = async (username: string) => {
    const b = new Browser(base);
    expect((await b.signIn(username)).status).toBe(303);
    return b;
  };
  /** An instrument value arriving for the ordered test, through the same code as matching. */
  const arrive = (value: string, units = 'mmol/L') =>
    db.$transaction((tx) =>
      attachObservation(tx, { instrumentId: 'c111-01', payload: null }, { id: uuidv7(), seq: 1, value: { kind: 'numeric', value, scale: value.split('.')[1]?.length ?? 0 }, units, abnormalFlags: [] }, { id: testId }),
    );

  beforeAll(async () => {
    db = createDb(url as string);
    app = await createApp(db, { secureCookies: false, twoPersonRule: true, logger: pino({ level: 'silent' }) });
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await app?.close();
    await db?.$disconnect();
  });

  beforeEach(async () => {
    await db.$executeRawUnsafe(`TRUNCATE ${TABLES} CASCADE`);
    await createUser(db, { username: 'tech', displayName: 'Tech One', password: PW, roles: ['technologist'] }, 'test');
    await createUser(db, { username: 'dr.lab', displayName: 'Dr Lab', password: PW, roles: ['approver'] }, 'test');
    await db.hmisCodeMap.create({ data: { hmisTestCode: 'HMIS-K', localTestCode: 'K' } });
    await db.instrument.create({
      data: { id: 'c111-01', displayName: 'c 111', manufacturer: 'Roche', model: 'cobas c 111', softwareVersion: '1', verifiedSoftwareVersion: '1', verificationStatus: 'LAB_ACCEPTED', enabled: true, discipline: 'chemistry', createdBy: 'test' },
    });
    const patientId = uuidv7();
    const orderId = uuidv7();
    const specimenId = uuidv7();
    testId = uuidv7();
    await db.patient.create({ data: { id: patientId, mrn: 'MRN9', familyName: 'Example', givenName: 'Ben', sex: 'M', birthDate: new Date('1980-01-01') } });
    await db.labOrder.create({ data: { id: orderId, hmisOrderId: 'ORD-9', patientId, priority: 'stat', orderedAt: new Date(), status: 'active', location: 'Ward 3', sourceJson: {} } });
    await db.specimen.create({ data: { id: specimenId, orderId, accessionNo: 'L26110400009', barcode: 'L26110400009', status: 'received', collectedAt: new Date(), createdBy: 'test' } });
    await db.orderedTest.create({ data: { id: testId, orderId, hmisLineId: '1', hmisTestCode: 'HMIS-K', localTestCode: 'K', status: 'collected', specimenId } });
  });

  const limitForm = { localTestCode: 'K', sex: '', ageMin: '', ageMinUnit: 'years', ageMax: '', ageMaxUnit: 'years', low: '2.5', high: '6.5', units: 'mmol/L', reference: 'Test policy T-1 v1', password: PW };

  it('lets only approvers set limits, checks them, and keeps retired ones', async () => {
    const tech = await as('tech');
    expect((await tech.get('/critical/limits')).html).toContain('No critical limits yet');
    expect((await tech.post('/critical/limits', { ...limitForm, _csrf: await tech.csrf('/critical/limits') })).status).toBe(403);

    const dr = await as('dr.lab');
    const csrf = await dr.csrf('/critical/limits');
    const bad = await dr.post('/critical/limits', { ...limitForm, _csrf: csrf, low: '7', password: 'not the password' });
    expect(bad.status).toBe(422); // values are checked before the password
    expect(bad.html).toContain('The low limit must be below the high limit.');
    expect((await dr.post('/critical/limits', { ...limitForm, _csrf: csrf, password: 'not the password' })).status).toBe(403);
    expect(await db.criticalLimit.count()).toBe(0);

    expect((await dr.post('/critical/limits', { ...limitForm, _csrf: csrf })).location).toBe('/critical/limits?notice=limit-added');
    const page = await dr.get('/critical/limits');
    expect(page.html).toContain('Test policy T-1 v1');
    expect(page.html).toContain('everyone, all ages');
    const id = (await db.criticalLimit.findFirstOrThrow()).id;
    expect((await dr.post(`/critical/limits/${id}/retire`, { _csrf: csrf, reason: 'x', password: PW })).status).toBe(422);
    expect((await dr.post(`/critical/limits/${id}/retire`, { _csrf: csrf, reason: 'replaced by v2', password: PW })).location).toBe('/critical/limits?notice=limit-retired');
    expect((await dr.get('/critical/limits')).html).toContain('replaced by v2');
    expect((await db.auditEvent.findMany({ where: { entityType: 'critical_limit' } })).map((e) => e.action).sort()).toEqual(['critical-limit.add', 'critical-limit.retire']);
  });

  it('flags a critical value, shows it waiting, and holds approval until the call is recorded', async () => {
    const dr = await as('dr.lab');
    await dr.post('/critical/limits', { ...limitForm, _csrf: await dr.csrf('/critical/limits') });

    const resultId = await arrive('7.2');
    expect((await db.resultVersion.findFirstOrThrow({ where: { resultId } })).criticalFlag).toBe('HIGH');
    expect((await dr.get('/')).html).toMatch(/1 critical result not yet called<\/strong> <span>oldest waiting 0:0\d/);
    // Every page's menu shows the call waiting beside Critical.
    expect((await dr.get('/orders')).html).toMatch(/href="\/critical">.*?<span>Critical<\/span><span class="badge rounded-pill text-bg-danger ms-auto">1<span class="visually-hidden"> waiting<\/span><\/span><\/a>/);
    const list = await dr.get('/critical');
    expect(list.html).toContain('EXAMPLE, Ben (MRN9)');
    expect(list.html).toContain('Ward 3');
    expect(list.html).toContain('above the critical limit 6.5 mmol/L');
    expect((await dr.get('/results')).html).toContain('critical HIGH');

    const tech = await as('tech');
    const tcsrf = await tech.csrf(`/results/${resultId}`);
    expect((await tech.get(`/results/${resultId}`)).html).toContain('Record the call');
    await tech.post(`/results/${resultId}/review`, { _csrf: tcsrf, versionNo: '1' });

    const dcsrf = await dr.csrf(`/results/${resultId}`);
    const held = await dr.post(`/results/${resultId}/approve`, { _csrf: dcsrf, password: PW });
    expect(held.status).toBe(409);
    expect(held.html).toContain('record who was told, with read-back');

    const call = { _csrf: tcsrf, versionNo: '1', notified: 'Nurse Achieng', notifiedRole: 'ward nurse, Ward 3', minutesAgo: '0', note: '', readBack: 'yes' };
    const noReadBack = await tech.post(`/results/${resultId}/critical-call`, { ...call, readBack: '' });
    expect(noReadBack.status).toBe(422);
    expect(noReadBack.html).toContain('call again');
    expect((await tech.post(`/results/${resultId}/critical-call`, { ...call, minutesAgo: 'soon' })).status).toBe(422);
    expect((await tech.post(`/results/${resultId}/critical-call`, { ...call, minutesAgo: '30' })).html).toContain('before the result arrived');
    expect((await tech.post(`/results/${resultId}/critical-call`, call)).location).toBe(`/results/${resultId}?notice=critical-called`);

    expect(await waitingCriticals(db)).toEqual([]);
    expect((await dr.get('/')).html).not.toContain('not yet called');
    const detail = await dr.get(`/results/${resultId}`);
    expect(detail.html).toContain('told Nurse Achieng (ward nurse, Ward 3)');
    expect(detail.html).not.toContain('Record the call');
    expect((await dr.post(`/results/${resultId}/approve`, { _csrf: dcsrf, password: PW })).location).toBe(`/results/${resultId}?notice=approved`);
    expect((await verifyAuditChain(db)).ok).toBe(true);
  });

  it("counts a waiting call against the lab's call target, the test's own target first (A-37)", async () => {
    const dr = await as('dr.lab');
    const csrf = await dr.csrf('/critical/limits');
    await dr.post('/critical/limits', { ...limitForm, _csrf: csrf });
    const tech = await as('tech');
    expect((await tech.post('/critical/targets', { _csrf: await tech.csrf('/critical'), localTestCode: '', minutes: '30', reference: 'Test policy T-2 v1', password: PW })).status).toBe(403);
    const bad = await dr.post('/critical/targets', { _csrf: csrf, localTestCode: '', minutes: '0', reference: 'x', password: PW });
    expect(bad.status).toBe(422);
    expect(bad.html).toContain('Target: 1 to 1440 minutes');

    const target = { _csrf: csrf, localTestCode: '', minutes: '30', reference: 'Test policy T-2 v1', password: PW };
    expect((await dr.post('/critical/targets', target)).location).toBe('/critical/limits?notice=call-target-set');
    expect((await dr.post('/critical/targets', { ...target, localTestCode: 'K', minutes: '20' })).location).toBe('/critical/limits?notice=call-target-set');
    // Setting the same scope again replaces the old target rather than adding a second.
    await dr.post('/critical/targets', { ...target, localTestCode: 'K', minutes: '15' });
    expect((await db.criticalCallTarget.findMany({ where: { active: true }, orderBy: { minutes: 'asc' } })).map((t) => [t.localTestCode, t.minutes])).toEqual([['K', 15], [null, 30]]);
    const page = (await dr.get('/critical/limits')).html;
    expect(page).toContain('15 min');
    expect(page).toContain('every test');

    const resultId = await arrive('7.2');
    const [w] = await waitingCriticals(db);
    expect(w).toMatchObject({ resultId, targetMinutes: 15 });
    expect(w!.due!.getTime() - w!.arrivedAt.getTime()).toBe(15 * 60_000);
    expect((await dr.get('/critical')).html).toMatch(/due in 0:1\d/);
    expect((await dr.get(`/results/${resultId}`)).html).toMatch(/for a call, due in 0:1\d/);
    expect((await dr.get('/')).html).not.toContain('past the call target');
    expect(pastTarget([w!], new Date(w!.arrivedAt.getTime() + 16 * 60_000))).toHaveLength(1);
    expect(pastTarget([w!], new Date(w!.arrivedAt.getTime() + 14 * 60_000))).toHaveLength(0);

    // Retiring the test's target falls back to the lab-wide one.
    const k = await db.criticalCallTarget.findFirstOrThrow({ where: { localTestCode: 'K', active: true } });
    expect((await dr.post(`/critical/targets/${k.id}/retire`, { _csrf: csrf, reason: 'policy changed', password: PW })).location).toBe('/critical/limits?notice=call-target-retired');
    expect((await waitingCriticals(db))[0]).toMatchObject({ targetMinutes: 30 });
    expect((await verifyAuditChain(db)).ok).toBe(true);
  });

  it('drops a critical superseded by a normal repeat before approval, and keeps one that arrives after', async () => {
    const dr = await as('dr.lab');
    await dr.post('/critical/limits', { ...limitForm, _csrf: await dr.csrf('/critical/limits') });
    const resultId = await arrive('2.1');
    expect((await waitingCriticals(db)).map((w) => w.flag)).toEqual(['LOW']);
    await arrive('4.0'); // repeat comes back normal and becomes the selected version
    expect(await waitingCriticals(db)).toEqual([]);

    // Units that differ from the limit are not compared: marked for a person instead.
    await arrive('12.0', 'mg/dL');
    const v3 = await db.resultVersion.findFirstOrThrow({ where: { resultId, versionNo: 3 } });
    expect(v3.criticalFlag).toBe('UNITS_DIFFER');
    expect((await dr.get(`/results/${resultId}`)).html).toContain('limit not checked: units differ');
    expect(await waitingCriticals(db)).toEqual([]);

    // The call is refused for a version that is not critical.
    const tech = await as('tech');
    const csrf = await tech.csrf(`/results/${resultId}`);
    expect((await tech.post(`/results/${resultId}/critical-call`, { _csrf: csrf, versionNo: '2', notified: 'Dr A', notifiedRole: 'doctor', minutesAgo: '0', readBack: 'yes' })).status).toBe(409);

    // A critical that arrives after approval stays on the list.
    await tech.post(`/results/${resultId}/review`, { _csrf: csrf, versionNo: '2' });
    await dr.post(`/results/${resultId}/approve`, { _csrf: await dr.csrf(`/results/${resultId}`), password: PW });
    await arrive('7.0');
    expect((await waitingCriticals(db)).map((w) => [w.versionNo, w.flag])).toEqual([[4, 'HIGH']]);
  });

  it('applies limits by sex', async () => {
    const dr = await as('dr.lab');
    await dr.post('/critical/limits', { ...limitForm, sex: 'F', _csrf: await dr.csrf('/critical/limits') });
    await arrive('7.2'); // the patient is male
    expect(await waitingCriticals(db)).toEqual([]);
  });
});

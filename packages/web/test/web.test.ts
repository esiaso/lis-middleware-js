import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createDb, uuidv7, type Db } from '@lis/db';
import { SimulatedHmis } from '@lis/hmis';
import { deliverOutbox, verifyAuditChain } from '@lis/lab';
import { createApp, createUser } from '@lis/web';
import { Browser, PW } from './browser.js';

const url = process.env['TEST_DATABASE_URL'];
const TABLES =
  'user_session, app_user, audit_event, delivery_attempt, outbox_message, result_event, result_version, result, unmatched_result, specimen, ordered_test, lab_order, patient, instrument, hmis_poll_status';

describe.skipIf(!url)('web screens over HTTP', () => {
  let db: Db;
  let app: NestExpressApplication;
  let base: string;
  let resultId: string;

  beforeAll(async () => {
    db = createDb(url as string);
    app = await createApp(db, { secureCookies: false, twoPersonRule: true, logger: (await import('pino')).pino({ level: 'silent' }) });
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
    await db.instrument.create({
      data: { id: 'e411-01', displayName: 'e 411', manufacturer: 'Roche', model: 'cobas e 411', softwareVersion: '02-04', verifiedSoftwareVersion: '02-04', verificationStatus: 'LAB_ACCEPTED', enabled: true, discipline: 'immunoassay', createdBy: 'test' },
    });
    const patientId = uuidv7();
    const orderId = uuidv7();
    const specimenId = uuidv7();
    const testId = uuidv7();
    resultId = uuidv7();
    await db.patient.create({ data: { id: patientId, mrn: 'MRN1', familyName: 'Example', givenName: 'Ann' } });
    await db.labOrder.create({ data: { id: orderId, hmisOrderId: 'ORD-1', patientId, priority: 'routine', orderedAt: new Date('2026-11-03T08:00:00Z'), status: 'active', sourceJson: {} } });
    await db.specimen.create({ data: { id: specimenId, orderId, accessionNo: 'L26110300001', barcode: 'L26110300001', status: 'received', createdBy: 'test' } });
    await db.orderedTest.create({ data: { id: testId, orderId, hmisLineId: '1', hmisTestCode: 'HMIS-TSH', localTestCode: 'TSH', status: 'collected', specimenId } });
    await db.result.create({ data: { id: resultId, orderedTestId: testId, status: 'received', selectedVersionNo: 1, instrumentId: 'e411-01' } });
    await db.resultVersion.create({ data: { id: uuidv7(), resultId, versionNo: 1, kind: 'initial', value: { kind: 'numeric', value: '1.50', scale: 2 }, units: 'uIU/mL', abnormalFlags: [], createdBy: 'e411-01' } });
  });

  it('answers the health check without a session', async () => {
    const r = await new Browser(base).get('/health');
    expect(r.status).toBe(200);
    expect(JSON.parse(r.html)).toEqual({ status: 'ok' });
    expect((await new Browser(base).get('/api/v1/health/live')).status).toBe(200);
    const ready = await new Browser(base).get('/api/v1/health/ready');
    expect(ready.status).toBe(200);
  });

  it('sends people without a session to the sign-in page, and sets security headers', async () => {
    const r = await new Browser(base).get('/results?status=received');
    expect(r.status).toBe(303);
    expect(r.location).toBe('/login?next=%2Fresults%3Fstatus%3Dreceived');
    const login = await new Browser(base).get('/login');
    expect(login.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(login.headers.get('x-frame-options')).toBe('DENY');
    expect(login.headers.get('x-powered-by')).toBeNull();
  });

  it('refuses a sign-in without the form token, or with a wrong password', async () => {
    const b = new Browser(base);
    expect((await b.post('/login', { username: 'tech', password: PW })).status).toBe(403);
    const wrong = await b.signIn('tech', 'wrong password!!');
    expect(wrong.status).toBe(401);
    expect(wrong.html).toContain('Wrong username or password');
    expect((await b.signIn('nobody')).status).toBe(401);
  });

  it('locks an account after five failed sign-ins', async () => {
    const b = new Browser(base);
    for (let i = 0; i < 5; i++) await b.signIn('tech', 'wrong password!!');
    const r = await b.signIn('tech');
    expect(r.status).toBe(401);
    expect(r.html).toContain('locked');
  });

  it('runs review → approval → release → HMIS from the screens, with roles, CSRF and password checks', async () => {
    const tech = new Browser(base);
    expect((await tech.signIn('tech')).location).toBe('/');
    const cookie = tech.cookies.get('lims_session');
    expect(cookie).toMatch(/^[0-9a-f]{64}$/);

    const list = await tech.get('/results?status=received');
    expect(list.html).toContain('EXAMPLE, Ann (MRN1)');
    expect(list.html).toContain('1.50 uIU/mL');
    // Searching by accession, MRN or test code finds it; something else does not.
    for (const q of ['L26110300001', 'mrn1', 'tsh', 'exam']) expect((await tech.get(`/results?q=${q}`)).html).toContain('EXAMPLE, Ann (MRN1)');
    const none = await tech.get('/results?q=nothing-like-it');
    expect(none.html).toContain('No results match');
    expect(none.html).not.toContain('EXAMPLE, Ann (MRN1)');
    expect(list.html).toMatch(/To review <span class="pill-count">1<\/span>/);
    expect((await tech.get('/results?page=7')).html).toContain('EXAMPLE, Ann (MRN1)'); // past the end shows the last page

    // A form posted without the session token is refused (CSRF).
    expect((await tech.post(`/results/${resultId}/review`, { versionNo: '1' })).status).toBe(403);
    let csrf = await tech.csrf(`/results/${resultId}`);
    expect((await tech.post(`/results/${resultId}/review`, { _csrf: csrf, versionNo: '1' })).location).toBe(`/results/${resultId}?notice=reviewed`);
    // A technologist cannot approve.
    expect((await tech.post(`/results/${resultId}/approve`, { _csrf: csrf, password: PW })).status).toBe(403);

    const dr = new Browser(base);
    await dr.signIn('dr.lab');
    csrf = await dr.csrf(`/results/${resultId}`);
    const wrongPw = await dr.post(`/results/${resultId}/approve`, { _csrf: csrf, password: 'not my password' });
    expect(wrongPw.status).toBe(403);
    expect(wrongPw.html).toContain('Password not confirmed');
    expect((await db.result.findUniqueOrThrow({ where: { id: resultId } })).status).toBe('reviewed');

    expect((await dr.post(`/results/${resultId}/approve`, { _csrf: csrf, password: PW })).location).toBe(`/results/${resultId}?notice=approved`);
    const detail = await dr.get(`/results/${resultId}?notice=approved`);
    expect(detail.html).toContain('Result approved.');
    expect(detail.html).toContain('Release to HMIS');
    expect((await dr.post(`/results/${resultId}/release`, { _csrf: csrf, password: PW })).status).toBe(303);

    const hmis = new SimulatedHmis();
    hmis.placeOrder({ hmisOrderId: 'ORD-1', patient: { mrn: 'MRN1', familyName: 'Example' }, orderedAt: '2026-11-03T08:00:00Z', lines: [{ hmisLineId: '1', testCode: 'HMIS-TSH' }] });
    const [report] = await deliverOutbox(db, hmis, 'test');
    expect(report).toMatchObject({ outcome: 'accepted' });
    expect(hmis.results).toHaveLength(1);
    expect((await db.result.findUniqueOrThrow({ where: { id: resultId } })).status).toBe('hmis_confirmed'); // delivery reads the result back

    const events = await db.resultEvent.findMany({ where: { resultId }, orderBy: { at: 'asc' } });
    expect(events.map((e) => [e.kind, e.actor]).slice(0, 3)).toEqual([['review', 'tech'], ['approve', 'dr.lab'], ['release', 'dr.lab']]);
    expect(await verifyAuditChain(db)).toMatchObject({ ok: true });
  });

  it('keeps the two-person rule: the reviewer cannot also approve', async () => {
    await db.appUser.update({ where: { username: 'dr.lab' }, data: { roles: ['technologist', 'approver'] } });
    const dr = new Browser(base);
    await dr.signIn('dr.lab');
    const csrf = await dr.csrf(`/results/${resultId}`);
    await dr.post(`/results/${resultId}/review`, { _csrf: csrf, versionNo: '1' });
    const r = await dr.post(`/results/${resultId}/approve`, { _csrf: csrf, password: PW });
    expect(r.status).toBe(409);
    expect(r.html).toContain('reviewer and approver must differ');
  });

  it('will not release results from an instrument that is not cleared for clinical use', async () => {
    await db.result.update({ where: { id: resultId }, data: { status: 'approved', reviewedBy: 'tech', approvedBy: 'dr.lab' } });
    await db.instrument.update({ where: { id: 'e411-01' }, data: { softwareVersion: '03-00' } });
    const dr = new Browser(base);
    await dr.signIn('dr.lab');
    const page = await dr.get(`/results/${resultId}`);
    expect(page.html).toContain('Not for clinical use');
    expect(page.html).not.toContain('Release to HMIS');
    const csrf = await dr.csrf(`/results/${resultId}`);
    const r = await dr.post(`/results/${resultId}/release`, { _csrf: csrf, password: PW });
    expect(r.status).toBe(409);
    expect(await db.outboxMessage.count()).toBe(0);
  });

  it('shows the dashboard, unmatched and failed lists, and ends the session on sign-out', async () => {
    const b = new Browser(base);
    await b.signIn('tech');
    const dash = await b.get('/');
    expect(dash.status).toBe(200);
    expect(dash.html).toContain('e 411');
    expect(dash.html).toContain('cleared');
    expect((await b.get('/unmatched')).html).toContain('Nothing unmatched');
    expect((await b.get('/failed')).status).toBe(200);
    expect((await b.get('/hmis')).html).toContain('No order poll has been recorded');
    expect(dash.html).not.toContain('href="/hmis">Open');
    expect(dash.html).toContain('No critical calls, QC failures, late results or HMIS link problems right now.');
    await db.hmisPollStatus.create({ data: { name: 'orders', profile: 'fhir-r4@1', lastAttemptAt: new Date(), failuresInARow: 3, lastError: 'ServiceRequest/sr9: no code with system https://hmis.example/test', lastErrorAt: new Date() } });
    expect((await b.get('/')).html).toContain('the last 3 order polls failed');
    const hmisPage = await b.get('/hmis');
    expect(hmisPage.html).toContain('failed 3 times in a row');
    expect(hmisPage.html).toContain('ServiceRequest/sr9: no code with system https://hmis.example/test');
    expect((await b.get('/results/not-a-uuid')).status).toBe(404);
    expect((await b.get('/static/bootstrap/bootstrap.min.css')).status).toBe(200);
    // The menu script is a file of our own, so the CSP still allows only script-src 'self'.
    expect((await b.get('/')).html).toContain('<script src="/static/app.js" defer></script>');
    expect((await b.get('/static/app.js')).status).toBe(200);
    const sprite = await b.get('/static/icons.svg');
    expect([sprite.status, sprite.html.startsWith('<svg xmlns="http://www.w3.org/2000/svg"><symbol id=')]).toEqual([200, true]);

    const token = b.cookies.get('lims_session') as string;
    const csrf = await b.csrf();
    expect((await b.post('/logout', { _csrf: csrf })).location).toBe('/login?notice=signedout');
    expect(await db.userSession.count()).toBe(0);
    b.cookies.set('lims_session', token); // replaying the old cookie does not work
    expect((await b.get('/')).status).toBe(303);
  });
});

import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createDb, uuidv7, type Db } from '@lis/db';
import { attachObservation, verifyAuditChain } from '@lis/lab';
import { createApp, createUser } from '@lis/web';
import { pino } from 'pino';
import { Browser, PW } from './browser.js';

const url = process.env['TEST_DATABASE_URL'];
const TABLES =
  'user_session, app_user, audit_event, autoverification_decision, autoverify_rule, delta_rule, critical_call, critical_limit, delivery_attempt, outbox_message, result_event, result_version, result, unmatched_result, specimen, ordered_test, lab_order, patient, instrument, hmis_code_map';

// The rule values below are made up for the test. They are not clinical guidance.
describe.skipIf(!url)('delta checks over HTTP', () => {
  let db: Db;
  let app: NestExpressApplication;
  let base: string;
  let patientId: string;
  let n = 0;

  const as = async (username: string) => {
    const b = new Browser(base);
    expect((await b.signIn(username)).status).toBe(303);
    return b;
  };
  /** A new order for the patient with one K test, collected `daysAgo` days ago. */
  const order = async (daysAgo: number, patient = patientId) => {
    n++;
    const orderId = uuidv7();
    const specimenId = uuidv7();
    const testId = uuidv7();
    const acc = `L2611040${String(n).padStart(4, '0')}`;
    await db.labOrder.create({ data: { id: orderId, hmisOrderId: `ORD-${n}`, patientId: patient, priority: 'routine', orderedAt: new Date(), status: 'active', location: 'Ward 3', sourceJson: {} } });
    await db.specimen.create({ data: { id: specimenId, orderId, accessionNo: acc, barcode: acc, status: 'received', collectedAt: new Date(Date.now() - daysAgo * 86_400_000), createdBy: 'test' } });
    await db.orderedTest.create({ data: { id: testId, orderId, hmisLineId: '1', hmisTestCode: 'HMIS-K', localTestCode: 'K', status: 'collected', specimenId } });
    return testId;
  };
  const arrive = (testId: string, value: string, units = 'mmol/L') =>
    db.$transaction((tx) =>
      attachObservation(
        tx,
        { instrumentId: 'c111-01', payload: { observations: [{ resultStatus: 'final', instrumentFlags: [], editedOnInstrument: false }] } },
        { id: uuidv7(), seq: 1, value: { kind: 'numeric', value, scale: value.split('.')[1]?.length ?? 0 }, units, abnormalFlags: [] },
        { id: testId },
      ),
    );
  const approveByHand = async (resultId: string) => {
    const tech = await as('tech');
    await tech.post(`/results/${resultId}/review`, { _csrf: await tech.csrf(`/results/${resultId}`), versionNo: '1' });
    const dr = await as('dr.lab');
    expect((await dr.post(`/results/${resultId}/approve`, { _csrf: await dr.csrf(`/results/${resultId}`), password: PW })).status).toBe(303);
  };
  const ruleForm = { localTestCode: 'K', maxAbs: '1.0', maxPercent: '', windowDays: '30', units: 'mmol/L', reference: 'Lab policy DC-01 v1', password: PW };

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
    patientId = uuidv7();
    await db.patient.create({ data: { id: patientId, mrn: 'MRN9', familyName: 'Example', givenName: 'Ben', sex: 'M', birthDate: new Date('1980-01-01') } });
  });

  it('lets only approvers add a rule, and checks it before the password', async () => {
    const tech = await as('tech');
    expect((await tech.get('/delta-checks')).html).toContain('No delta rules');
    expect((await tech.post('/delta-checks', { ...ruleForm, _csrf: await tech.csrf('/delta-checks') })).status).toBe(403);
    const dr = await as('dr.lab');
    const csrf = await dr.csrf('/delta-checks');
    const bad = await dr.post('/delta-checks', { ...ruleForm, _csrf: csrf, maxAbs: '', password: 'wrong' });
    expect(bad.status).toBe(422);
    expect(bad.html).toContain('Enter a largest change');
    expect((await dr.post('/delta-checks', { ...ruleForm, _csrf: csrf, password: 'wrong' })).status).toBe(403);
    expect((await dr.post('/delta-checks', { ...ruleForm, _csrf: csrf })).location).toBe('/delta-checks?notice=delta-added');
    expect((await dr.post('/delta-checks', { ...ruleForm, _csrf: csrf })).html).toContain('already has an active delta rule');
    const rule = await db.deltaRule.findFirstOrThrow();
    expect((await dr.post(`/delta-checks/${rule.id}/retire`, { _csrf: csrf, reason: 'replaced by v2', password: PW })).location).toBe('/delta-checks?notice=delta-retired');
    expect((await db.auditEvent.findMany({ where: { entityType: 'delta_rule' } })).map((e) => e.action).sort()).toEqual(['delta-rule.add', 'delta-rule.retire']);
  });

  it('compares with the last approved result in the window, shows it, and holds autoverification', async () => {
    const dr = await as('dr.lab');
    await dr.post('/delta-checks', { ...ruleForm, _csrf: await dr.csrf('/delta-checks') });

    // Outside the window, and another patient's result, are never compared.
    const old = await arrive(await order(40), '9.0');
    await approveByHand(old);
    const other = uuidv7();
    await db.patient.create({ data: { id: other, mrn: 'MRN10', sex: 'F' } });
    await approveByHand(await arrive(await order(2, other), '9.0'));

    const first = await arrive(await order(5), '4.0');
    expect((await db.resultVersion.findFirstOrThrow({ where: { resultId: first } })).deltaFlag).toBeNull();
    await approveByHand(first);

    // Not yet approved results are not a baseline: this one is compared with `first`.
    const unreviewed = await arrive(await order(3), '5.5');
    const v = await db.resultVersion.findFirstOrThrow({ where: { resultId: unreviewed } });
    expect(v).toMatchObject({ deltaFlag: 'EXCEEDED', deltaPreviousResultId: first, deltaDetail: 'changed by 1.5 mmol/L from 4.0 (more than 1.0 mmol/L)' });
    const page = await dr.get(`/results/${unreviewed}`);
    expect(page.html).toContain('changed by 1.5 mmol/L from 4.0');
    expect(page.html).toContain(`href="/results/${first}"`);
    expect((await dr.get('/results')).html).toContain('>delta</span>');
    // A flag does not block approval by a person.
    await approveByHand(unreviewed);

    // Different units are not compared, and say so.
    const mg = await arrive(await order(1), '20', 'mg/dL');
    expect((await db.resultVersion.findFirstOrThrow({ where: { resultId: mg } })).deltaFlag).toBe('UNITS_DIFFER');

    // Autoverification holds a flagged value and passes one inside the delta.
    await dr.post('/autoverification', { localTestCode: 'K', low: '3.0', high: '6.0', units: 'mmol/L', reference: 'Validation AV-K v1', qc: 'yes', password: PW, _csrf: await dr.csrf('/autoverification') });
    const close = await arrive(await order(0), '5.2'); // previous approved is 5.5
    expect((await db.result.findUniqueOrThrow({ where: { id: close } })).approvedBy).toBe('system:autoverify');
    const jump = await arrive(await order(0), '3.1'); // previous is now 5.2
    expect((await db.result.findUniqueOrThrow({ where: { id: jump } })).status).toBe('received');
    const d = await db.autoverificationDecision.findFirstOrThrow({ where: { resultId: jump } });
    expect((d.checks as { check: string; ok: boolean }[]).filter((c) => !c.ok).map((c) => c.check)).toEqual(['delta check']);
    expect((await verifyAuditChain(db)).ok).toBe(true);
  });
});

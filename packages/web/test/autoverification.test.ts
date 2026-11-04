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
  'user_session, app_user, audit_event, autoverification_decision, autoverify_rule, critical_call, critical_limit, delivery_attempt, outbox_message, result_event, result_version, result, unmatched_result, specimen, ordered_test, lab_order, patient, instrument, hmis_code_map';

// The rule and limit values below are made up for the test. They are not clinical guidance.
describe.skipIf(!url)('autoverification over HTTP', () => {
  let db: Db;
  let app: NestExpressApplication;
  let base: string;
  let testId: string;

  const as = async (username: string) => {
    const b = new Browser(base);
    expect((await b.signIn(username)).status).toBe(303);
    return b;
  };
  type Meta = { resultStatus?: string; instrumentFlags?: { code: string }[]; editedOnInstrument?: boolean };
  /** An instrument value arriving for the ordered test, through the same code as matching. */
  const arrive = (value: string, meta: Meta | null = { resultStatus: 'final', instrumentFlags: [], editedOnInstrument: false }, units = 'mmol/L') =>
    db.$transaction((tx) =>
      attachObservation(
        tx,
        { instrumentId: 'c111-01', payload: meta ? { observations: [meta] } : null },
        { id: uuidv7(), seq: 1, value: { kind: 'numeric', value, scale: value.split('.')[1]?.length ?? 0 }, units, abnormalFlags: [] },
        { id: testId },
      ),
    );
  const newTest = async () => {
    const t = await db.orderedTest.findUniqueOrThrow({ where: { id: testId } });
    testId = uuidv7();
    await db.orderedTest.create({ data: { id: testId, orderId: t.orderId, hmisLineId: String(Math.random()).slice(2, 8), hmisTestCode: 'HMIS-K', localTestCode: 'K', status: 'collected', specimenId: t.specimenId } });
  };
  const ruleForm = { localTestCode: 'K', low: '3.5', high: '5.0', units: 'mmol/L', reference: 'Validation AV-K v1', qc: 'yes', password: PW };

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
    await db.labOrder.create({ data: { id: orderId, hmisOrderId: 'ORD-9', patientId, priority: 'routine', orderedAt: new Date(), status: 'active', location: 'Ward 3', sourceJson: {} } });
    await db.specimen.create({ data: { id: specimenId, orderId, accessionNo: 'L26110400009', barcode: 'L26110400009', status: 'received', collectedAt: new Date(), createdBy: 'test' } });
    await db.orderedTest.create({ data: { id: testId, orderId, hmisLineId: '1', hmisTestCode: 'HMIS-K', localTestCode: 'K', status: 'collected', specimenId } });
  });

  it('does nothing without a rule', async () => {
    const resultId = await arrive('4.2');
    expect((await db.result.findUniqueOrThrow({ where: { id: resultId } })).status).toBe('received');
    expect(await db.autoverificationDecision.count()).toBe(0);
    expect((await (await as('tech')).get('/autoverification')).html).toContain('No rules. Every result is reviewed and approved by a person.');
  });

  it('lets only approvers add a rule, and checks it before the password', async () => {
    const tech = await as('tech');
    expect((await tech.post('/autoverification', { ...ruleForm, _csrf: await tech.csrf('/autoverification') })).status).toBe(403);
    const dr = await as('dr.lab');
    const csrf = await dr.csrf('/autoverification');
    const noQc = await dr.post('/autoverification', { ...ruleForm, _csrf: csrf, qc: '', password: 'wrong' });
    expect(noQc.status).toBe(422);
    expect(noQc.html).toContain('the middleware does not check QC');
    expect((await dr.post('/autoverification', { ...ruleForm, _csrf: csrf, password: 'wrong' })).status).toBe(403);
    expect((await dr.post('/autoverification', { ...ruleForm, _csrf: csrf })).location).toBe('/autoverification?notice=autoverify-added');
    const again = await dr.post('/autoverification', { ...ruleForm, _csrf: csrf });
    expect(again.status).toBe(422);
    expect(again.html).toContain('already has an active rule');
    expect((await dr.get('/autoverification')).html).toContain('Validation AV-K v1');
  });

  it('approves a clean value, leaves release to a person, and holds the rest with reasons', async () => {
    const dr = await as('dr.lab');
    await dr.post('/autoverification', { ...ruleForm, _csrf: await dr.csrf('/autoverification') });

    const passed = await arrive('4.2');
    const r = await db.result.findUniqueOrThrow({ where: { id: passed } });
    expect(r).toMatchObject({ status: 'approved', approvedBy: 'system:autoverify' });
    expect(await db.outboxMessage.count()).toBe(0);
    const page = await dr.get(`/results/${passed}`);
    expect(page.html).toContain('autoverified');
    expect(page.html).toContain('Validation AV-K v1');
    // The approve event satisfies the database's outbox check when a person releases it.
    expect((await dr.post(`/results/${passed}/release`, { _csrf: await dr.csrf(`/results/${passed}`), password: PW })).location).toBe(`/results/${passed}?notice=released`);
    expect(await db.outboxMessage.count()).toBe(1);

    // A repeat after autoverification raises the usual alert instead of being approved.
    await arrive('4.3', { resultStatus: 'rerun' });
    expect((await db.result.findUniqueOrThrow({ where: { id: passed } })).newDataAfterApproval).toBe(true);
    expect(await db.autoverificationDecision.count()).toBe(1);

    const cases: [string, Meta | null, string][] = [
      ['5.1', undefined as unknown as Meta, 'range'],
      ['4.2', { resultStatus: 'final', instrumentFlags: [{ code: '>Test' }] }, 'instrument flags'],
      ['4.2', { resultStatus: 'final', editedOnInstrument: true }, 'not edited'],
      ['4.2', null, 'instrument flags'], // no metadata at all: held
    ];
    for (const [value, meta, check] of cases) {
      await newTest();
      const id = meta === undefined ? await arrive(value) : await arrive(value, meta);
      expect((await db.result.findUniqueOrThrow({ where: { id } })).status).toBe('received');
      const d = await db.autoverificationDecision.findFirstOrThrow({ where: { resultId: id } });
      expect(d.passed).toBe(false);
      expect((d.checks as { check: string; ok: boolean }[]).filter((c) => !c.ok).map((c) => c.check)).toContain(check);
    }
    await newTest();
    const wrongUnits = await arrive('4.2', undefined, 'mg/dL');
    expect((await dr.get(`/results/${wrongUnits}`)).html).toContain('Left for a person by autoverification');

    // An instrument no longer cleared for clinical use is never autoverified.
    await db.instrument.update({ where: { id: 'c111-01' }, data: { softwareVersion: '2' } });
    await newTest();
    const uncleared = await arrive('4.2');
    expect((await db.result.findUniqueOrThrow({ where: { id: uncleared } })).status).toBe('received');
    expect((await verifyAuditChain(db)).ok).toBe(true);
  });

  it('holds a critical value even inside the rule range', async () => {
    const dr = await as('dr.lab');
    await dr.post('/autoverification', { ...ruleForm, _csrf: await dr.csrf('/autoverification') });
    await dr.post('/critical/limits', { localTestCode: 'K', sex: '', ageMin: '', ageMinUnit: 'years', ageMax: '', ageMaxUnit: 'years', low: '', high: '4.8', units: 'mmol/L', reference: 'Test policy T-1 v1', password: PW, _csrf: await dr.csrf('/critical/limits') });
    const id = await arrive('4.9');
    expect((await db.result.findUniqueOrThrow({ where: { id } })).status).toBe('received');
  });

  it('stops after the rule is turned off', async () => {
    const dr = await as('dr.lab');
    const csrf = await dr.csrf('/autoverification');
    await dr.post('/autoverification', { ...ruleForm, _csrf: csrf });
    const rule = await db.autoverifyRule.findFirstOrThrow();
    expect((await dr.post(`/autoverification/${rule.id}/retire`, { _csrf: csrf, reason: 'revalidating', password: PW })).location).toBe('/autoverification?notice=autoverify-retired');
    const id = await arrive('4.2');
    expect((await db.result.findUniqueOrThrow({ where: { id } })).status).toBe('received');
    expect(await db.autoverificationDecision.count()).toBe(0);
    expect((await db.auditEvent.findMany({ where: { entityType: 'autoverify_rule' } })).map((e) => e.action).sort()).toEqual(['autoverify-rule.add', 'autoverify-rule.retire']);
  });
});

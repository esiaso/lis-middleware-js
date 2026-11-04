import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createDb, uuidv7, type Db, type JsonInput } from '@lis/db';
import { attachObservation, failingQc, matchNormalizedMessage, verifyAuditChain } from '@lis/lab';
import { createApp, createUser } from '@lis/web';
import { pino } from 'pino';
import { Browser, PW } from './browser.js';

const url = process.env['TEST_DATABASE_URL'];
const TABLES =
  'user_session, app_user, audit_event, qc_evaluation, qc_range, autoverification_decision, autoverify_rule, delta_rule, critical_call, critical_limit, delivery_attempt, outbox_message, result_event, result_version, result, unmatched_result, observation, normalized_message, specimen, ordered_test, lab_order, patient, instrument, hmis_code_map';

// The ranges below are made up for the test. They are not from any control insert.
describe.skipIf(!url)('QC log over HTTP', () => {
  let db: Db;
  let app: NestExpressApplication;
  let base: string;
  let testId: string;

  const as = async (username: string) => {
    const b = new Browser(base);
    expect((await b.signIn(username)).status).toBe(303);
    return b;
  };
  /** A QC message from the c 111 through the same matching code intake uses. */
  const qc = async (values: [string, string][], qcInfo: { lot?: string; controlName?: string } = { lot: 'L123', controlName: 'PC1' }, units = 'mmol/L') => {
    const id = uuidv7();
    await db.normalizedMessage.create({
      data: { id, rawMessageId: uuidv7(), seq: 1, instrumentId: 'c111-01', adapterName: 'test', adapterVersion: '1', kind: 'result', sampleClass: 'qc', sampleId: 'QC1', sampleIdReadError: false, payload: { qc: qcInfo, observations: [] } as JsonInput },
    });
    for (const [i, [code, value]] of values.entries()) {
      await db.observation.create({
        data: { id: uuidv7(), normalizedMessageId: id, seq: i + 1, instrumentTestCode: code, originalValueText: value, value: { kind: 'numeric', value, scale: value.split('.')[1]?.length ?? 0 }, units, abnormalFlags: [], mapping: 'QC', localTestCode: code === '99' ? null : code },
      });
    }
    return db.$transaction((tx) => matchNormalizedMessage(tx, id));
  };
  const arrive = () =>
    db.$transaction((tx) =>
      attachObservation(tx, { instrumentId: 'c111-01', payload: { observations: [{ resultStatus: 'final', instrumentFlags: [], editedOnInstrument: false }] } }, { id: uuidv7(), seq: 1, value: { kind: 'numeric', value: '4.2', scale: 1 }, units: 'mmol/L', abnormalFlags: [] }, { id: testId }),
    );
  const rangeForm = { instrumentId: 'c111-01', localTestCode: 'K', controlLot: 'L123', controlName: '', low: '4.1', high: '4.9', units: 'mmol/L', reference: 'Control insert L123 rev 2', password: PW };

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

  it('keeps QC results without ranges, and checks them once ranges exist', async () => {
    expect((await qc([['K', '4.5'], ['99', '1.0']])).qc).toBe(2);
    expect((await db.qcEvaluation.findMany({ orderBy: { localTestCode: 'asc' } })).map((e) => [e.outcome, e.detail])).toEqual([
      ['NO_RANGE', 'no range for PC1, lot L123'],
      ['NO_RANGE', 'instrument test 99 is not mapped to a lab test'],
    ]);
    expect(await db.result.count()).toBe(0); // QC never reaches patient tables

    const tech = await as('tech');
    expect((await tech.post('/qc/ranges', { ...rangeForm, _csrf: await tech.csrf('/qc/ranges') })).status).toBe(403);
    const dr = await as('dr.lab');
    const csrf = await dr.csrf('/qc/ranges');
    const bad = await dr.post('/qc/ranges', { ...rangeForm, _csrf: csrf, controlLot: '', password: 'wrong' });
    expect(bad.status).toBe(422);
    expect(bad.html).toContain('Enter the control lot, the control name, or both');
    expect((await dr.post('/qc/ranges', { ...rangeForm, _csrf: csrf, password: 'wrong' })).status).toBe(403);
    expect((await dr.post('/qc/ranges', { ...rangeForm, _csrf: csrf })).location).toBe('/qc/ranges?notice=qc-range-added');
    expect((await dr.post('/qc/ranges', { ...rangeForm, _csrf: csrf })).html).toContain('already has an active range');

    await qc([['K', '5.2']]);
    expect((await failingQc(db)).map((f) => f.detail)).toEqual(['5.2 outside 4.1 to 4.9 mmol/L']);
    expect((await dr.get('/')).html).toContain('QC failed: 1');
    const log = await dr.get('/qc');
    expect(log.html).toContain('Latest QC failed');
    expect(log.html).toContain('out of range');

    // A rerun in range clears the warning; history stays.
    await qc([['K', '4.6']]);
    expect(await failingQc(db)).toEqual([]);
    expect((await dr.get('/')).html).not.toContain('QC failed');
    expect(await db.qcEvaluation.count()).toBe(4);

    const range = await db.qcRange.findFirstOrThrow();
    expect((await dr.post(`/qc/ranges/${range.id}/retire`, { _csrf: csrf, reason: 'new lot L124', password: PW })).location).toBe('/qc/ranges?notice=qc-range-retired');
    expect((await db.auditEvent.findMany({ where: { entityType: 'qc_range' } })).map((e) => e.action).sort()).toEqual(['qc-range.add', 'qc-range.retire']);
    expect((await verifyAuditChain(db)).ok).toBe(true);
  });

  it('lets an autoverification rule require QC in range within a window', async () => {
    const dr = await as('dr.lab');
    await dr.post('/qc/ranges', { ...rangeForm, _csrf: await dr.csrf('/qc/ranges') });
    expect((await dr.post('/autoverification', { localTestCode: 'K', low: '3.0', high: '6.0', units: 'mmol/L', reference: 'Validation AV-K v1', qc: 'yes', qcWithinHours: '8', password: PW, _csrf: await dr.csrf('/autoverification') })).status).toBe(303);
    expect((await dr.get('/autoverification')).html).toContain('QC in range within 8 h');

    // No QC yet: held.
    const first = await arrive();
    const d1 = await db.autoverificationDecision.findFirstOrThrow({ where: { resultId: first } });
    expect((d1.checks as { check: string; ok: boolean; detail: string }[]).find((c) => c.check === 'QC')).toMatchObject({ ok: false, detail: 'no checked QC result in the last 8 h' });

    // QC in range: passes.
    await qc([['K', '4.5']]);
    const t = await db.orderedTest.findUniqueOrThrow({ where: { id: testId } });
    testId = uuidv7();
    await db.orderedTest.create({ data: { id: testId, orderId: t.orderId, hmisLineId: '2', hmisTestCode: 'HMIS-K', localTestCode: 'K', status: 'collected', specimenId: t.specimenId } });
    expect((await db.result.findUniqueOrThrow({ where: { id: await arrive() } })).approvedBy).toBe('system:autoverify');

    // Latest QC out: held again.
    await qc([['K', '5.5']]);
    testId = uuidv7();
    await db.orderedTest.create({ data: { id: testId, orderId: t.orderId, hmisLineId: '3', hmisTestCode: 'HMIS-K', localTestCode: 'K', status: 'collected', specimenId: t.specimenId } });
    expect((await db.result.findUniqueOrThrow({ where: { id: await arrive() } })).status).toBe('received');
  });

  it('applies the Westgard rules the lab chose, along one control\'s accepted results', async () => {
    const dr = await as('dr.lab');
    const csrf = await dr.csrf('/qc/ranges');
    const noTarget = await dr.post('/qc/ranges', { ...rangeForm, _csrf: csrf, westgardRules: ['2-2s'] });
    expect(noTarget.status).toBe(422);
    expect(noTarget.html).toContain('Westgard rules need the target mean and SD');
    // Mean 4.5, SD 0.1: the range 4.1 to 4.9 is ±4 SD, so the rules decide first.
    expect((await dr.post('/qc/ranges', { ...rangeForm, _csrf: csrf, targetMean: '4.5', targetSd: '0.1', westgardRules: ['1-2s', '1-3s', '2-2s'] })).location).toBe('/qc/ranges?notice=qc-range-added');
    const page = await dr.get('/qc/ranges');
    expect(page.html).toContain('4.5 ± 0.1');
    expect(page.html).toContain('1-2s, 1-3s, 2-2s');

    await qc([['K', '4.73']]); // z 2.3: warning only
    let e = await db.qcEvaluation.findFirstOrThrow({ orderBy: { at: 'desc' } });
    expect([e.outcome, e.zScore, e.westgardWarn, e.westgardReject]).toEqual(['IN_RANGE', 2.3, ['1-2s'], []]);
    expect((await dr.get('/qc')).html).toContain('1-2s warning');

    await qc([['K', '4.72']]); // second beyond +2 SD in a row: 2-2s
    e = await db.qcEvaluation.findFirstOrThrow({ orderBy: [{ at: 'desc' }, { id: 'desc' }] });
    expect([e.outcome, e.westgardReject]).toEqual(['RULE_VIOLATION', ['2-2s']]);
    expect(e.detail).toBe('4.72 within 4.1 to 4.9 mmol/L, z 2.20; breaks 2-2s; warning 1-2s');
    expect((await failingQc(db)).length).toBe(1);
    expect((await dr.get('/')).html).toContain('QC failed: 1');

    // A rerun near the mean passes; the rejected result does not count again.
    await qc([['K', '4.52']]);
    expect(await failingQc(db)).toEqual([]);
    await qc([['K', '4.75']]); // only one beyond +2 SD among accepted results since
    e = await db.qcEvaluation.findFirstOrThrow({ orderBy: [{ at: 'desc' }, { id: 'desc' }] });
    expect(e.outcome).toBe('IN_RANGE');
    await qc([['K', '4.85']]); // z 3.5: 1-3s, inside the range
    e = await db.qcEvaluation.findFirstOrThrow({ orderBy: [{ at: 'desc' }, { id: 'desc' }] });
    expect(e.westgardReject).toEqual(['1-3s', '2-2s']);

    // The Levey-Jennings chart plots every numeric result for the range, linked from the log.
    const range = await db.qcRange.findFirstOrThrow();
    expect((await dr.get('/qc')).html).toContain(`/qc/ranges/${range.id}/chart`);
    const chart = await dr.get(`/qc/ranges/${range.id}/chart`);
    expect(chart.status).toBe(200);
    expect(chart.html.match(/<circle class="lj-mark"/g)?.length).toBe(5);
    expect(chart.html).toContain('mean 4.5');
    expect(chart.html).toContain('4.85 mmol/L, z 3.50, breaks 1-3s, 2-2s, warning 1-2s'); // the point's tooltip
    expect((await dr.get(`/qc/ranges/${uuidv7()}/chart`)).status).toBe(404);
  });

  it('summarises each range over a period, with a CSV for approvers and auditors', async () => {
    const dr = await as('dr.lab');
    const csrf = await dr.csrf('/qc/ranges');
    expect((await dr.post('/qc/ranges', { ...rangeForm, _csrf: csrf, targetMean: '4.5', targetSd: '0.1' })).status).toBe(303);
    for (const v of ['4.4', '4.5', '4.6', '5.0']) await qc([['K', v]]);
    await qc([['K', '81']], { lot: 'L123', controlName: 'PC1' }, 'mg/dL'); // other units: not compared

    const tech = await as('tech');
    const page = await tech.get('/qc/summary');
    expect(page.status).toBe(200);
    expect(page.html).toContain('c 111');
    // Mean 4.625, sample SD 0.263, CV 5.7 %, bias 2.8 %, shift 1.25 SD; one rejected, one not compared.
    const row = page.html.slice(page.html.indexOf('<td>c 111</td>'));
    for (const text of ['>4<', '>4.63<', '>0.26<', '>5.7<', '>4.4<', '>5.0<', '>2.8<', '>1.25<']) expect(row).toContain(text);
    expect(row).toMatch(/text-end">1<\/td><td class="text-end">0<\/td><td class="text-end">1<\/td>/); // rejected, warnings, not compared
    expect(page.html).not.toContain('/qc/summary.csv');
    expect((await tech.get('/qc/summary.csv')).status).toBe(403);

    expect((await dr.get('/qc/summary?from=2026-13-01')).html).toContain('is not a date');
    const csv = await dr.get('/qc/summary.csv');
    expect(csv.status).toBe(200);
    const [head, line, ...rest] = csv.html.trim().split('\r\n');
    expect(head).toBe('instrument_id,instrument,test,control_name,control_lot,units,low,high,target_mean,target_sd,range_active,n,mean,sd,cv_percent,min,max,bias_percent,shift_sd,rejected,warnings,not_compared');
    expect(line).toBe('c111-01,c 111,K,,L123,mmol/L,4.1,4.9,4.5,0.1,yes,4,4.63,0.26,5.7,4.4,5.0,2.8,1.25,1,0,1');
    expect(rest).toEqual([]);
    expect(await db.auditEvent.count({ where: { action: 'report.qc-summary-export' } })).toBe(1);

    // An earlier period has nothing.
    expect((await dr.get('/qc/summary?from=2020-01-01&to=2020-01-31')).html).toContain('No QC results were checked against a range');
  });
});

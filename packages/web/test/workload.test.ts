import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createDb, uuidv7, type Db, type JsonInput } from '@lis/db';
import { createApp, createUser } from '@lis/web';
import { pino } from 'pino';
import { Browser, PW } from './browser.js';

const url = process.env['TEST_DATABASE_URL'];
const TABLES =
  'user_session, app_user, audit_event, qc_evaluation, unmatched_result, result_event, result_version, result, observation, normalized_message, specimen, ordered_test, lab_order, patient, instrument';

describe.skipIf(!url)('workload report over HTTP', () => {
  let db: Db;
  let app: NestExpressApplication;
  let base: string;
  let orderId: string;
  const yesterday = new Date(Date.now() - 86_400_000);
  const at = (h: number) => new Date(Date.UTC(yesterday.getUTCFullYear(), yesterday.getUTCMonth(), yesterday.getUTCDate(), h));
  const dayText = at(0).toISOString().slice(0, 10);

  const as = async (username: string) => {
    const b = new Browser(base);
    expect((await b.signIn(username)).status).toBe(303);
    return b;
  };
  /** An instrument message with one observation, arriving at `when`. */
  const observation = async (instrumentId: string, code: string, when: Date, sampleClass = 'patient') => {
    const nm = uuidv7();
    await db.normalizedMessage.create({
      data: { id: nm, rawMessageId: uuidv7(), seq: 1, instrumentId, adapterName: 'test', adapterVersion: '1', kind: 'result', sampleClass, sampleId: 'S1', sampleIdReadError: false, payload: { observations: [] } as JsonInput, createdAt: when },
    });
    const id = uuidv7();
    await db.observation.create({ data: { id, normalizedMessageId: nm, seq: 1, instrumentTestCode: code, originalValueText: '4.2', value: { kind: 'numeric', value: '4.2', scale: 1 }, units: 'mmol/L', abnormalFlags: [], mapping: 'MAPPED', localTestCode: code } });
    return id;
  };
  /** A patient result whose versions come from these observations (null: typed by a person). */
  const result = async (code: string, obs: (string | null)[]) => {
    const testId = uuidv7();
    const resultId = uuidv7();
    await db.orderedTest.create({ data: { id: testId, orderId, hmisLineId: testId, hmisTestCode: `HMIS-${code}`, localTestCode: code, status: 'collected' } });
    await db.result.create({ data: { id: resultId, orderedTestId: testId, status: 'received', selectedVersionNo: obs.length } });
    for (const [i, o] of obs.entries()) {
      await db.resultVersion.create({ data: { id: uuidv7(), resultId, versionNo: i + 1, kind: o ? 'initial' : 'correction', value: { kind: 'numeric', value: '4.2', scale: 1 }, abnormalFlags: [], observationId: o, createdBy: 'test' } });
    }
  };

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
    for (const [id, name] of [['c111-01', 'c 111'], ['e411-01', 'e 411']] as const) {
      await db.instrument.create({ data: { id, displayName: name, manufacturer: 'Roche', model: name, softwareVersion: '1', verifiedSoftwareVersion: '1', verificationStatus: 'LAB_ACCEPTED', enabled: true, discipline: 'chemistry', createdBy: 'test' } });
    }
    const patientId = uuidv7();
    orderId = uuidv7();
    await db.patient.create({ data: { id: patientId, mrn: 'MRN9', familyName: 'Example', givenName: 'Ben' } });
    await db.labOrder.create({ data: { id: orderId, hmisOrderId: 'ORD-1', patientId, priority: 'routine', orderedAt: at(7), status: 'active', sourceJson: {} } });
  });

  it('counts measurements, repeats, QC and quarantined values per instrument, test and day', async () => {
    await result('K', [await observation('c111-01', 'K', at(8))]);
    await result('K', [await observation('c111-01', 'K', at(9)), await observation('c111-01', 'K', at(10)), null]); // a rerun, then a person's correction
    await result('TSH', [await observation('e411-01', 'TSH', at(9))]);
    await result('K', [await observation('c111-01', 'K', new Date(at(0).getTime() - 3_600_000))]); // the day before: outside the range
    const qcObs = await observation('c111-01', 'K', at(8), 'qc');
    await db.qcEvaluation.create({ data: { id: uuidv7(), observationId: qcObs, instrumentId: 'c111-01', localTestCode: 'K', value: { kind: 'numeric', value: '4.5', scale: 1 }, outcome: 'NO_RANGE', detail: 'x', at: at(8) } });
    await db.unmatchedResult.create({ data: { id: uuidv7(), observationId: await observation('e411-01', 'TSH', at(11)), reason: 'NO_SPECIMEN', sampleId: 'S9', instrumentId: 'e411-01', createdAt: at(11) } });

    const tech = await as('tech');
    const page = await tech.get(`/reports/workload?from=${dayText}&to=${dayText}`);
    expect(page.status).toBe(200);
    const text = page.html.replace(/<[^>]+>/g, '|').replace(/\s+/g, ' ').replace(/\|( ?\|)+/g, '|');
    expect(text).toContain('|c 111|3|1|1|0|'); // measurements, repeats, QC, quarantined
    expect(text).toContain('|e 411|1|0|0|1|');
    expect(text).toContain('|All instruments|4|1|1|1|');
    expect(text).toContain(`|${dayText}|4|1|1|`);
    expect(page.html).not.toContain('Download CSV');
    expect((await tech.get('/reports/workload.csv')).status).toBe(403);
    expect((await tech.get('/reports/workload?from=x')).html).toContain('is not a date');

    const dr = await as('dr.lab');
    const csv = await dr.get(`/reports/workload.csv?from=${dayText}&to=${dayText}`);
    expect(csv.status).toBe(200);
    expect(csv.html.trim().split('\r\n')).toEqual(['day,instrument_id,instrument,test,measurements,repeats', `${dayText},c111-01,c 111,K,3,1`, `${dayText},e411-01,e 411,TSH,1,0`]);
    expect(csv.html).not.toContain('MRN9');
    expect(await db.auditEvent.count({ where: { action: 'report.workload-export' } })).toBe(1);
  });
});

import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createDb, uuidv7, type Db } from '@lis/db';
import type { HistoryResult } from '@lis/lab';
import { createApp, createUser } from '@lis/web';
import { pino } from 'pino';
import { cumulative } from '../src/cumulative.js';
import { Browser, PW } from './browser.js';

const h = (over: Partial<HistoryResult>): HistoryResult => ({
  resultId: uuidv7(), orderId: 'o', hmisOrderId: 'ORD', test: 'K', status: 'sent', at: new Date('2026-11-03T08:00:00Z'), collected: true,
  value: { kind: 'numeric', value: '4.2', scale: 1 }, units: 'mmol/L', abnormalFlags: [], criticalFlag: null, deltaFlag: null, ...over,
});

describe('cumulative', () => {
  it('puts collections in columns, newest first, and tests in rows', () => {
    const c = cumulative([
      h({ test: 'NA', at: new Date('2026-11-03T08:00:20Z'), value: { kind: 'numeric', value: '140', scale: 0 } }),
      h({ at: new Date('2026-11-03T08:00:00Z') }),
      h({ at: new Date('2026-11-04T09:00:00Z'), status: 'received', criticalFlag: 'HIGH', abnormalFlags: ['H'] }),
    ]);
    expect(c.columns.map((x) => x.label)).toEqual(['2026-11-04 09:00 UTC', '2026-11-03 08:00 UTC']);
    expect(c.rows.map((r) => r.test)).toEqual(['K', 'NA']);
    expect(c.rows[0]!.cells[0]![0]).toMatchObject({ value: '4.2', approved: false, critical: 'HIGH', flags: 'H' });
    expect(c.rows[1]!.cells[0]).toEqual([]);
    expect(c.rows[1]!.cells[1]![0]).toMatchObject({ value: '140', approved: true });
  });
  it('keeps only the newest columns and says how many are hidden', () => {
    const many = Array.from({ length: 15 }, (_, i) => h({ at: new Date(Date.UTC(2026, 10, 1 + i)) }));
    const c = cumulative(many, 12);
    expect(c.columns).toHaveLength(12);
    expect(c.hidden).toBe(3);
    expect(c.columns[0]!.label).toBe('2026-11-15 00:00 UTC');
  });
});

const url = process.env['TEST_DATABASE_URL'];
const TABLES = 'user_session, app_user, audit_event, result_event, result_version, result, specimen, ordered_test, lab_order, patient';

describe.skipIf(!url)('patient history over HTTP', () => {
  let db: Db;
  let app: NestExpressApplication;
  let base: string;
  let n = 0;

  const add = async (patientId: string, test: string, value: string, collectedAt: Date, status = 'sent') => {
    n++;
    const orderId = uuidv7();
    const specimenId = uuidv7();
    const testId = uuidv7();
    const resultId = uuidv7();
    await db.labOrder.create({ data: { id: orderId, hmisOrderId: `ORD-${n}`, patientId, priority: 'routine', orderedAt: collectedAt, status: 'active', sourceJson: {} } });
    await db.specimen.create({ data: { id: specimenId, orderId, accessionNo: `L2611040${String(n).padStart(4, '0')}`, barcode: `B${n}`, status: 'received', collectedAt, createdBy: 'test' } });
    await db.orderedTest.create({ data: { id: testId, orderId, hmisLineId: '1', hmisTestCode: `HMIS-${test}`, localTestCode: test, status: 'collected', specimenId } });
    await db.result.create({ data: { id: resultId, orderedTestId: testId, status, selectedVersionNo: 1 } });
    await db.resultVersion.create({ data: { id: uuidv7(), resultId, versionNo: 1, kind: 'initial', value: { kind: 'numeric', value, scale: value.split('.')[1]?.length ?? 0 }, units: 'mmol/L', abnormalFlags: [], createdBy: 'system:x' } });
    return resultId;
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
  });

  it('finds a patient and shows only their results, linked from the result page', async () => {
    const ben = uuidv7();
    const ann = uuidv7();
    await db.patient.create({ data: { id: ben, mrn: 'MRN9', familyName: 'Example', givenName: 'Ben', sex: 'M' } });
    await db.patient.create({ data: { id: ann, mrn: 'MRN10', familyName: 'Exampleton', givenName: 'Ann' } });
    const old = await add(ben, 'K', '3.9', new Date('2026-11-01T07:00:00Z'));
    const recent = await add(ben, 'K', '5.8', new Date('2026-11-03T07:00:00Z'), 'received');
    await add(ann, 'K', '9.9', new Date('2026-11-03T07:00:00Z'));

    const b = new Browser(base);
    expect((await b.signIn('tech')).status).toBe(303);
    const found = await b.get('/patients?q=examp');
    expect(found.html).toContain('EXAMPLE, Ben');
    expect(found.html).toContain('EXAMPLETON, Ann');
    expect((await b.get('/patients?q=mrn9')).location).toBe(`/patients/${ben}`);

    const page = await b.get(`/patients/${ben}`);
    expect(page.html).toContain(`href="/results/${old}"`);
    expect(page.html).toContain(`href="/results/${recent}"`);
    expect(page.html).toContain('(not approved)');
    expect(page.html).not.toContain('9.9');
    expect(page.html.indexOf('2026-11-03 07:00')).toBeLessThan(page.html.indexOf('2026-11-01 07:00'));

    expect((await b.get(`/results/${old}`)).html).toContain(`href="/patients/${ben}"`);
    expect((await b.get(`/patients/${uuidv7()}`)).status).toBe(404);
  });
});

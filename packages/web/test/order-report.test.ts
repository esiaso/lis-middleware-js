import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createDb, uuidv7, type Db, type JsonInput } from '@lis/db';
import { createApp, createUser } from '@lis/web';
import { pino } from 'pino';
import { Browser, PW } from './browser.js';

const url = process.env['TEST_DATABASE_URL'];
const TABLES = 'user_session, app_user, audit_event, result_event, result_version, result, observation, normalized_message, specimen, ordered_test, lab_order, patient';

describe.skipIf(!url)('printed result report', () => {
  let db: Db;
  let app: NestExpressApplication;
  let base: string;
  let orderId: string;
  let specimenId: string;

  const test = async (line: string, code: string, opts: { status?: string; value?: string; testStatus?: string; approvedBy?: string; range?: string; kind?: string } = {}) => {
    const testId = uuidv7();
    await db.orderedTest.create({ data: { id: testId, orderId, hmisLineId: line, hmisTestCode: `HMIS-${code}`, localTestCode: code, status: opts.testStatus ?? 'collected', specimenId } });
    if (!opts.status) return;
    const resultId = uuidv7();
    await db.result.create({ data: { id: resultId, orderedTestId: testId, status: opts.status, selectedVersionNo: 1, ...(opts.approvedBy ? { approvedBy: opts.approvedBy } : {}) } });
    let observationId: string | null = null;
    if (opts.range) {
      const nm = uuidv7();
      observationId = uuidv7();
      await db.normalizedMessage.create({ data: { id: nm, rawMessageId: uuidv7(), seq: 1, instrumentId: 'c111-01', adapterName: 't', adapterVersion: '1', kind: 'result', sampleClass: 'patient', sampleIdReadError: false, payload: { observations: [{ referenceRangeText: opts.range }] } as JsonInput } });
      await db.observation.create({ data: { id: observationId, normalizedMessageId: nm, seq: 1, instrumentTestCode: code, originalValueText: opts.value ?? '', value: {}, abnormalFlags: [], mapping: 'MAPPED', localTestCode: code } });
    }
    await db.resultVersion.create({ data: { id: uuidv7(), resultId, versionNo: 1, kind: opts.kind ?? 'initial', value: { kind: 'numeric', value: opts.value ?? '1', scale: 1 }, units: 'mmol/L', abnormalFlags: opts.range ? ['H'] : [], observationId, createdBy: 'system:x' } });
    if (opts.approvedBy) await db.resultEvent.create({ data: { id: uuidv7(), resultId, kind: 'approve', versionNo: 1, actor: opts.approvedBy } });
  };

  beforeAll(async () => {
    db = createDb(url as string);
    app = await createApp(db, { secureCookies: false, twoPersonRule: true, logger: pino({ level: 'silent' }), reportHeader: 'District Hospital Laboratory, PO Box 1' });
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
    const patientId = uuidv7();
    orderId = uuidv7();
    specimenId = uuidv7();
    await db.patient.create({ data: { id: patientId, mrn: 'MRN9', familyName: 'Example', givenName: 'Ben', sex: 'M' } });
    await db.labOrder.create({ data: { id: orderId, hmisOrderId: 'ORD-9', patientId, priority: 'routine', orderedAt: new Date(), status: 'active', location: 'Ward 3', sourceJson: {} } });
    await db.specimen.create({ data: { id: specimenId, orderId, accessionNo: 'L26110400009', barcode: 'L26110400009', status: 'received', collectedAt: new Date(), createdBy: 'test' } });
  });

  it('prints approved values only, with the instrument range and the approver, and audits each view', async () => {
    await test('1', 'K', { status: 'sent', value: '5.6', approvedBy: 'dr.lab', range: '3.5-5.1' });
    await test('2', 'NA', { status: 'reviewed', value: '999.9' });
    await test('3', 'CL', { status: 'approved', value: '101.0', approvedBy: 'system:autoverify' });
    await test('4', 'CA', { testStatus: 'cancelled' });
    await test('5', 'GLU', { status: 'corrected', value: '7.1', approvedBy: 'dr.lab', kind: 'correction' });

    const b = new Browser(base);
    expect((await b.signIn('tech')).status).toBe(303);
    expect((await b.get(`/orders/${orderId}`)).html).toContain(`/orders/${orderId}/report`);
    const r = await b.get(`/orders/${orderId}/report`);
    expect(r.status).toBe(200);
    expect(r.html).toContain('District Hospital Laboratory, PO Box 1');
    expect(r.html).toContain('EXAMPLE, Ben');
    expect(r.html).toContain('5.6');
    expect(r.html).toContain('3.5-5.1');
    expect(r.html).toContain('Dr Lab');
    expect(r.html).toContain('autoverified');
    expect(r.html).toContain('(corrected)');
    expect(r.html).not.toContain('999.9'); // reviewed but not approved
    expect(r.html).toContain('Pending');
    expect(r.html).toContain('Cancelled');
    expect(r.html).toContain('Printed');
    expect(await db.auditEvent.count({ where: { action: 'order.report-viewed', entityId: orderId } })).toBe(1);
  });
});

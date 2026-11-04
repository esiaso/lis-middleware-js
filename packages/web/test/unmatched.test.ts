import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createDb, uuidv7, type Db } from '@lis/db';
import { verifyAuditChain } from '@lis/lab';
import { createApp, createUser } from '@lis/web';
import { pino } from 'pino';
import { Browser, PW } from './browser.js';

const url = process.env['TEST_DATABASE_URL'];
const TABLES =
  'user_session, app_user, audit_event, delivery_attempt, outbox_message, result_event, result_version, result, unmatched_result, observation, normalized_message, specimen, ordered_test, lab_order, patient, instrument';

describe.skipIf(!url)('linking an unmatched result to a specimen over HTTP', () => {
  let db: Db;
  let app: NestExpressApplication;
  let base: string;
  let unmatchedId: string;
  let unmappedId: string;
  let tshTestId: string;
  const as = async (username: string) => {
    const b = new Browser(base);
    expect((await b.signIn(username)).status).toBe(303);
    return b;
  };

  beforeAll(async () => {
    db = createDb(url as string);
    app = await createApp(db, { secureCookies: false, logger: pino({ level: 'silent' }) });
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await app?.close();
    await db?.$disconnect();
  });

  async function quarantined(code: string, local: string | null, value: string, reason: string, sampleId = '@412'): Promise<string> {
    const nmId = uuidv7();
    const obsId = uuidv7();
    await db.normalizedMessage.create({
      data: { id: nmId, rawMessageId: uuidv7(), seq: 1, instrumentId: 'e411-01', adapterName: 'test', adapterVersion: '1', kind: 'result', sampleClass: 'patient', sampleId, sampleIdReadError: true, payload: { observations: [{}] } },
    });
    await db.observation.create({
      data: { id: obsId, normalizedMessageId: nmId, seq: 1, instrumentTestCode: code, originalValueText: value, value: { kind: 'numeric', value, scale: 2 }, units: 'uIU/mL', abnormalFlags: [], mapping: local ? 'MAPPED' : 'UNMAPPED', localTestCode: local },
    });
    const id = uuidv7();
    await db.unmatchedResult.create({ data: { id, observationId: obsId, reason, sampleId, instrumentId: 'e411-01' } });
    return id;
  }

  beforeEach(async () => {
    await db.$executeRawUnsafe(`TRUNCATE ${TABLES} CASCADE`);
    for (const [username, roles] of [['tech', ['technologist']], ['tech2', ['technologist']], ['phleb', ['operator']]] as const) {
      await createUser(db, { username, displayName: username, password: PW, roles: [...roles] }, 'test');
    }
    await db.instrument.create({
      data: { id: 'e411-01', displayName: 'e 411', manufacturer: 'Roche', model: 'cobas e 411', verificationStatus: 'LAB_ACCEPTED', enabled: true, discipline: 'immunoassay', createdBy: 'test' },
    });
    const patientId = uuidv7();
    const orderId = uuidv7();
    const specimenId = uuidv7();
    tshTestId = uuidv7();
    await db.patient.create({ data: { id: patientId, mrn: 'MRN7', familyName: 'Example', givenName: 'Ben', birthDate: new Date('1975-05-05') } });
    await db.labOrder.create({ data: { id: orderId, hmisOrderId: 'ORD-7', patientId, priority: 'routine', orderedAt: new Date(), status: 'active', sourceJson: {} } });
    await db.specimen.create({ data: { id: specimenId, orderId, accessionNo: 'L26110400007', barcode: 'L26110400007', status: 'received', createdBy: 'test' } });
    await db.orderedTest.create({ data: { id: tshTestId, orderId, hmisLineId: '1', hmisTestCode: 'H-TSH', localTestCode: 'TSH', status: 'active', specimenId } });
    unmatchedId = await quarantined('TSH', 'TSH', '2.10', 'UNKNOWN_BARCODE');
    unmappedId = await quarantined('XYZ', null, '1.00', 'UNKNOWN_BARCODE');
  });

  it('needs a second person, with password, before the result reaches the patient', async () => {
    const tech = await as('tech');
    expect((await tech.get('/unmatched')).html).toContain(`href="/unmatched/${unmatchedId}"`);
    const page = await tech.get(`/unmatched/${unmatchedId}`);
    expect(page.status).toBe(200);
    expect(page.html).toContain('barcode read error');
    const csrf = await tech.csrf(`/unmatched/${unmatchedId}`);

    // Refused: short reason, unknown accession, a specimen without that test.
    expect((await tech.post(`/unmatched/${unmatchedId}/propose`, { _csrf: csrf, accessionNo: 'L26110400007', reason: 'short' })).status).toBe(409);
    expect((await tech.post(`/unmatched/${unmatchedId}/propose`, { _csrf: csrf, accessionNo: 'L99999999999', reason: 'barcode label was smudged' })).html).toContain('no specimen with that accession number');

    const p = await tech.post(`/unmatched/${unmatchedId}/propose`, { _csrf: csrf, accessionNo: 'l26110400007', reason: 'barcode label was smudged, tube checked by hand' });
    expect(p.location).toBe(`/unmatched/${unmatchedId}?notice=link-proposed`);
    const proposed = await tech.get(`/unmatched/${unmatchedId}`);
    expect(proposed.html).toContain('EXAMPLE, Ben · MRN MRN7 · born 1975-05-05');
    expect(proposed.html).toContain('A different person must confirm.');
    expect(proposed.html).not.toContain('Confirm link');
    expect(await db.result.count()).toBe(0); // nothing on the patient yet

    // The proposer cannot confirm their own proposal, even by posting directly.
    expect((await tech.post(`/unmatched/${unmatchedId}/confirm`, { _csrf: csrf, password: PW })).status).toBe(409);

    const tech2 = await as('tech2');
    const csrf2 = await tech2.csrf(`/unmatched/${unmatchedId}`);
    expect((await tech2.get(`/unmatched/${unmatchedId}`)).html).toContain('Confirm link');
    expect((await tech2.post(`/unmatched/${unmatchedId}/confirm`, { _csrf: csrf2, password: 'wrong password!!' })).status).toBe(403);
    expect(await db.result.count()).toBe(0);

    const c = await tech2.post(`/unmatched/${unmatchedId}/confirm`, { _csrf: csrf2, password: PW });
    const result = await db.result.findFirstOrThrow({ include: { versions: true } });
    expect(c.location).toBe(`/results/${result.id}?notice=linked`);
    expect(result).toMatchObject({ orderedTestId: tshTestId, status: 'received', instrumentId: 'e411-01' });
    expect(result.versions[0]).toMatchObject({ value: { kind: 'numeric', value: '2.10', scale: 2 }, units: 'uIU/mL' });
    const u = await db.unmatchedResult.findUniqueOrThrow({ where: { id: unmatchedId } });
    expect(u).toMatchObject({ resolvedBy: 'tech2', linkedResultId: result.id });
    expect(u.resolution).toContain('proposed by tech');
    expect((await tech2.get('/unmatched')).html).not.toContain(`href="/unmatched/${unmatchedId}"`);
    expect((await tech2.get(`/unmatched/${unmatchedId}`)).html).toContain('open the result');
    expect((await tech2.post(`/unmatched/${unmatchedId}/confirm`, { _csrf: csrf2, password: PW })).status).toBe(409);

    const specimen = await db.specimen.findUniqueOrThrow({ where: { accessionNo: 'L26110400007' } });
    expect((await tech2.get(`/specimens/${specimen.id}`)).html).toContain('Unmatched result linked by tech2');
    expect((await verifyAuditChain(db)).ok).toBe(true);
  });

  it('can withdraw a proposal, refuses unmapped codes and rejected specimens, and keeps operators out', async () => {
    const tech = await as('tech');
    const csrf = await tech.csrf(`/unmatched/${unmatchedId}`);
    await tech.post(`/unmatched/${unmatchedId}/propose`, { _csrf: csrf, accessionNo: 'L26110400007', reason: 'label smudged, checked by hand' });
    expect((await tech.post(`/unmatched/${unmatchedId}/propose`, { _csrf: csrf, accessionNo: 'L26110400007', reason: 'label smudged, checked by hand' })).html).toContain('already proposed');
    expect((await tech.post(`/unmatched/${unmatchedId}/withdraw`, { _csrf: csrf })).location).toBe(`/unmatched/${unmatchedId}?notice=link-withdrawn`);
    expect(await db.unmatchedResult.findUniqueOrThrow({ where: { id: unmatchedId } })).toMatchObject({ proposedBy: null, resolvedAt: null });

    expect((await tech.get(`/unmatched/${unmappedId}`)).html).toContain('has no active mapping');
    expect((await tech.post(`/unmatched/${unmappedId}/propose`, { _csrf: csrf, accessionNo: 'L26110400007', reason: 'label smudged, checked by hand' })).html).toContain('fix the test mapping first');

    // A proposal made before the specimen was rejected cannot be confirmed after.
    await tech.post(`/unmatched/${unmatchedId}/propose`, { _csrf: csrf, accessionNo: 'L26110400007', reason: 'label smudged, checked by hand' });
    await db.specimen.update({ where: { accessionNo: 'L26110400007' }, data: { status: 'rejected' } });
    const tech2 = await as('tech2');
    const csrf2 = await tech2.csrf(`/unmatched/${unmatchedId}`);
    expect((await tech2.post(`/unmatched/${unmatchedId}/confirm`, { _csrf: csrf2, password: PW })).html).toContain('was rejected');
    expect(await db.result.count()).toBe(0);

    const phleb = await as('phleb');
    const pc = await phleb.csrf(`/unmatched/${unmatchedId}`);
    expect((await phleb.get(`/unmatched/${unmatchedId}`)).html).not.toContain('Withdraw proposal');
    expect((await phleb.post(`/unmatched/${unmatchedId}/withdraw`, { _csrf: pc })).status).toBe(403);
  });
});

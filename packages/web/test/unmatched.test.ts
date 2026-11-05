import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createDb, uuidv7, type Db } from '@lis/db';
import { approve, release, review, verifyAuditChain } from '@lis/lab';
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
  let orderUuid: string;
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

  async function quarantined(code: string, local: string | null, value: string, reason: string, sampleId = '@412', readError = true): Promise<string> {
    const nmId = uuidv7();
    const obsId = uuidv7();
    await db.normalizedMessage.create({
      data: { id: nmId, rawMessageId: uuidv7(), seq: 1, instrumentId: 'e411-01', adapterName: 'test', adapterVersion: '1', kind: 'result', sampleClass: 'patient', sampleId, sampleIdReadError: readError, payload: { observations: [{}] } },
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
    orderUuid = orderId;
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

  it('adds a test a clinician asked for, held from the HMIS until their order line arrives and is matched (A-34)', async () => {
    // The instrument read this tube's barcode and ran FT4, which the order does not have.
    const ft4 = await quarantined('FT4', 'FT4', '14.2', 'NOT_ORDERED', 'L26110400007', false);
    const other = await db.specimen.create({ data: { id: uuidv7(), orderId: orderUuid, accessionNo: 'L26110400008', barcode: 'L26110400008', status: 'received', createdBy: 'test' } });
    const tech = await as('tech');
    const page = (await tech.get(`/unmatched/${ft4}`)).html;
    expect(page).toContain('Add FT4 to the order');
    expect(page).toContain('value="L26110400007"');
    expect((await tech.get(`/unmatched/${unmatchedId}`)).html).not.toContain('Propose added test'); // a misread barcode is linked, not added
    const csrf = await tech.csrf(`/unmatched/${ft4}`);
    const add = (over: Record<string, string>) => tech.post(`/unmatched/${ft4}/add-test`, { _csrf: csrf, accessionNo: 'L26110400007', requestedBy: 'Dr A. Example', reason: 'phoned the lab at 10:15 from ward 3', ...over });
    expect((await add({ requestedBy: '' })).html).toContain('name the clinician who asked for the test');
    expect((await add({ accessionNo: other.accessionNo })).html).toContain('L26110400008 is not the tube the instrument read (L26110400007)');
    expect((await tech.post(`/unmatched/${unmatchedId}/add-test`, { _csrf: csrf, accessionNo: 'L26110400007', requestedBy: 'Dr A. Example', reason: 'phoned the lab at 10:15 from ward 3' })).html).toContain('a test can be added only when the instrument read a known barcode');
    expect((await add({})).location).toBe(`/unmatched/${ft4}?notice=add-test-proposed`);
    const proposed = (await tech.get(`/unmatched/${ft4}`)).html;
    expect(proposed).toContain('Add FT4 to order ORD-7 on');
    expect(proposed).toContain('asked for by <strong>Dr A. Example</strong>');
    expect((await tech.post(`/unmatched/${ft4}/confirm`, { _csrf: csrf, password: PW })).status).toBe(409);
    expect(await db.orderedTest.count()).toBe(1);

    const tech2 = await as('tech2');
    const csrf2 = await tech2.csrf(`/unmatched/${ft4}`);
    expect((await tech2.get(`/unmatched/${ft4}`)).html).toContain('Confirm added test');
    const c = await tech2.post(`/unmatched/${ft4}/confirm`, { _csrf: csrf2, password: PW });
    const result = await db.result.findFirstOrThrow({ include: { orderedTest: true } });
    expect(c.location).toBe(`/results/${result.id}?notice=linked`);
    expect(result.orderedTest).toMatchObject({ source: 'LAB_ADDED', localTestCode: 'FT4', requestedBy: 'Dr A. Example', addedBy: 'tech', addedConfirmedBy: 'tech2', status: 'active' });
    expect((await tech2.get(`/results/${result.id}`)).html).toContain('at the request of Dr A. Example');

    // Reviewed and approved as usual, but not sent to the HMIS.
    await review(db, result.id, 'tech', 1);
    await approve(db, result.id, 'tech2', { twoPersonRule: false });
    await expect(release(db, result.id, { username: 'tech2', displayName: 'tech2' })).rejects.toMatchObject({ error: { code: 'NOT_RELEASABLE' } });
    expect((await tech2.get(`/orders/${orderUuid}`)).html).toContain('waiting for the HMIS line');

    // The clinician orders it; the next poll brings the line, and a person matches it.
    const lineId = uuidv7();
    await db.orderedTest.create({ data: { id: lineId, orderId: orderUuid, hmisLineId: '2', hmisTestCode: 'H-FT4', localTestCode: 'FT4', status: 'active' } });
    const order = (await tech2.get(`/orders/${orderUuid}`)).html;
    expect(order).toContain('The lab already ran this as an added test; match it below');
    expect(order).toContain(`<option value="${lineId}">2 (H-FT4)</option>`);
    const oc = await tech2.csrf(`/orders/${orderUuid}`);
    expect((await tech2.post(`/orders/${orderUuid}/match-added`, { _csrf: oc, addedTestId: result.orderedTestId, hmisTestId: tshTestId, password: PW })).html).toContain('that line is TSH, not FT4');
    expect((await tech2.post(`/orders/${orderUuid}/match-added`, { _csrf: oc, addedTestId: result.orderedTestId, hmisTestId: lineId, password: PW })).location).toBe(`/orders/${orderUuid}?notice=added-test-matched`);
    expect(await db.result.findUniqueOrThrow({ where: { id: result.id } })).toMatchObject({ orderedTestId: lineId });
    expect(await db.orderedTest.findUniqueOrThrow({ where: { id: lineId } })).toMatchObject({ specimenId: result.orderedTest.specimenId });
    expect(await db.orderedTest.findUniqueOrThrow({ where: { id: result.orderedTestId } })).toMatchObject({ status: 'reconciled', specimenId: null, matchedToId: lineId, matchedBy: 'tech2' });
    const after = (await tech2.get(`/orders/${orderUuid}`)).html;
    expect(after).toContain('Matched to line <span class="font-monospace">2</span> by tech2');
    expect(after).not.toContain('match it below');
    expect((await tech2.get(`/results/${result.id}`)).html).not.toContain('at the request of');
    expect((await tech2.post(`/orders/${orderUuid}/match-added`, { _csrf: oc, addedTestId: result.orderedTestId, hmisTestId: lineId, password: PW })).html).toContain('already reconciled by tech2');
    expect(await db.auditEvent.count({ where: { action: { in: ['unmatched.add-test-proposed', 'unmatched.add-test-confirmed', 'order.test-added', 'order.added-test-matched'] } } })).toBe(4);
    expect((await verifyAuditChain(db)).ok).toBe(true);
  });

  it('refuses to add a test the order already has, or to a cancelled order', async () => {
    const tsh = await quarantined('TSH', 'TSH', '2.10', 'NOT_ORDERED', 'L26110400007', false);
    const tech = await as('tech');
    const csrf = await tech.csrf(`/unmatched/${tsh}`);
    const add = () => tech.post(`/unmatched/${tsh}/add-test`, { _csrf: csrf, accessionNo: 'L26110400007', requestedBy: 'Dr A. Example', reason: 'phoned the lab at 10:15 from ward 3' });
    expect((await add()).html).toContain('L26110400007 already has TSH ordered; link the result to it instead');
    await db.orderedTest.update({ where: { id: tshTestId }, data: { status: 'cancelled' } });
    await db.labOrder.update({ where: { id: orderUuid }, data: { status: 'cancelled' } });
    expect((await add()).html).toContain('order ORD-7 is cancelled');
  });
});

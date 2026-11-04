import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { acquireLease, createDb, PrismaRawMessageStore, startLinkSession, uuidv7, type Db } from '@lis/db';
import { FhirR4Hmis } from '@lis/hmis';
import { accessionSpecimen, addResultComment, approve, deliverOutbox, pullOrders, release, review } from '@lis/lab';
import { runIntakeBatch } from '@lis/result-intake';
import { feedLine, startStubFhir, SYSTEMS, type StubFhir } from '../../hmis/test/fhir-stub.js';

const url = process.env['TEST_DATABASE_URL'];
const ALL_TABLES =
  'audit_event, delivery_attempt, outbox_message, result_event, result_comment, result_version, result, unmatched_result, specimen, ordered_test, lab_order, patient, hmis_code_map, hmis_cursor, observation, normalized_message, inbox_message, raw_frame, raw_message, link_session, instrument_connection_lease, instrument_verification_evidence, instrument_connection, test_mapping_set, instrument';

const upload = (barcode: string, value: string) =>
  Buffer.from(
    [
      'H|\\^&|||cobas-e411^1|||||host|RSUPL^REAL|P|1',
      'P|1',
      `O|1|${barcode}|40^0^5^^S1^SC|^^^10^|R||||||N||||1|||||||20261104095504|||F`,
      `R|1|^^^10/not|${value}^|uIU/mL||N||F||admin|||E1`,
      'L|1|N',
    ].map((r) => `${r}\r`).join(''),
    'latin1',
  );

describe.skipIf(!url)('FHIR HMIS (stand-in) → order → result → release → delivery', () => {
  let db: Db;
  let stub: StubFhir;
  let hmis: FhirR4Hmis;
  let store: PrismaRawMessageStore;

  beforeAll(() => {
    db = createDb(url as string);
  });
  afterAll(async () => {
    await db?.$disconnect();
  });
  beforeEach(async () => {
    await db.$executeRawUnsafe(`TRUNCATE ${ALL_TABLES} CASCADE`);
    stub = await startStubFhir();
    hmis = new FhirR4Hmis({
      baseUrl: new URL(stub.base),
      tokenUrl: new URL(stub.tokenUrl),
      clientId: stub.clientId,
      clientSecret: () => stub.clientSecret,
      scopes: 'system/*.*',
      pageSize: 10,
      systems: SYSTEMS,
      limsSystemPrefix: 'urn:lims-middleware:',
      timeoutMs: 2000,
      allowHttp: true,
    });
    await db.instrument.create({
      data: { id: 'e411-01', displayName: 'e 411', manufacturer: 'Roche', model: 'cobas e 411', softwareVersion: '02-04', discipline: 'immunoassay', createdBy: 'test', enabled: true, verificationStatus: 'LAB_ACCEPTED', verifiedSoftwareVersion: '02-04' },
    });
    await db.instrumentConnection.create({
      data: { id: uuidv7(), instrumentId: 'e411-01', configJson: { instrumentId: 'e411-01', adapter: 'cobas-e411-astm', transport: { type: 'tcp-client', host: '10.0.0.1', port: 4001 } }, activeFrom: new Date(Date.now() - 60_000), createdBy: 'test' },
    });
    await db.testMappingSet.create({
      data: { id: uuidv7(), instrumentId: 'e411-01', versionNo: 1, status: 'ACTIVE', createdBy: 'tech', approvedBy: 'dr.lab', approvedAt: new Date(), mappingsJson: [{ localTestCode: 'TSH', instrumentTestCode: '10', direction: 'both', reportable: true, ruo: false }] },
    });
    await db.hmisCodeMap.create({ data: { hmisTestCode: 'HMIS-TSH', localTestCode: 'TSH' } });
    const lease = (await acquireLease(db, 'e411-01', 'w:1'))!;
    store = new PrismaRawMessageStore(db, lease, await startLinkSession(db, lease));
  });
  afterEach(async () => {
    await stub.close();
  });

  /** Nine other orders first, so ORD-1's two lines arrive on different pages. */
  async function orderReleased() {
    for (let i = 0; i < 9; i++) stub.feed.push(feedLine({ srId: `x${i}`, order: `OTHER-${i}`, line: `X-${i}`, test: 'HMIS-TSH', mrn: `MRN-X${i}` }));
    stub.feed.push(feedLine({ srId: 'sr1', order: 'ORD-1', line: 'L-1', test: 'HMIS-TSH', mrn: 'MRN1' }), feedLine({ srId: 'sr2', order: 'ORD-1', line: 'L-2', test: 'HMIS-FT4', mrn: 'MRN1' }));
    expect(await pullOrders(db, hmis)).toEqual({ received: 11, created: 10 });
    expect(await pullOrders(db, hmis)).toEqual({ received: 0, created: 0 });
    expect((await db.hmisCursor.findUniqueOrThrow({ where: { name: 'orders' } })).cursor).toBe('11');
    const order = await db.labOrder.findUniqueOrThrow({ where: { hmisOrderId: 'ORD-1' }, include: { tests: { orderBy: { hmisLineId: 'asc' } }, patient: true } });
    expect(order.tests.map((t) => [t.hmisLineId, t.localTestCode])).toEqual([['L-1', 'TSH'], ['L-2', null]]);
    expect(order.patient).toMatchObject({ mrn: 'MRN1', familyName: 'Example', givenName: 'Pat', sex: 'F' });
    const { accessionNo } = await accessionSpecimen(db, { orderId: order.id, orderedTestIds: [order.tests[0]!.id], user: 'phleb', now: new Date('2026-11-04T08:40:00Z') });
    await store.storeAstmTransfer({ text: upload(accessionNo, '5.40'), complete: true, frameCount: 1, receivedAt: new Date() });
    await runIntakeBatch(db, 'jobs:1');
    const r = await db.result.findFirstOrThrow();
    await review(db, r.id, 'tech.a', 1);
    await approve(db, r.id, 'dr.lab', { twoPersonRule: true });
    await addResultComment(db, r.id, 'dr.lab', { text: 'Repeat in 6 weeks', onReport: true });
    await addResultComment(db, r.id, 'dr.lab', { text: 'internal note', onReport: false });
    const { idempotencyKey } = await release(db, r.id, { username: 'dr.lab', displayName: 'Dr Lab' });
    return { resultId: r.id, idempotencyKey, accessionNo };
  }

  it('sends the released result once and confirms it by read-back', async () => {
    const { resultId, idempotencyKey, accessionNo } = await orderReleased();
    const [d] = await deliverOutbox(db, hmis, 'jobs:1');
    expect(d).toMatchObject({ outcome: 'accepted', resultStatus: 'hmis_confirmed' });
    expect(stub.transactions).toHaveLength(1);
    expect(stub.transactions[0]).toContain('"value":5.40');
    const obs = [...stub.store.entries()].find(([k]) => k.startsWith('Observation/'))![1];
    expect(obs).toMatchObject({
      subject: { identifier: { system: SYSTEMS.mrn, value: 'MRN1' } },
      basedOn: [{ identifier: { system: SYSTEMS.orderLine, value: 'L-1' } }],
      code: { coding: [{ system: SYSTEMS.test, code: 'HMIS-TSH' }] },
      specimen: { display: accessionNo },
      note: [{ text: 'Repeat in 6 weeks' }],
      identifier: [{ value: 'L-1' }, { value: idempotencyKey }],
    });
    expect((await db.result.findUniqueOrThrow({ where: { id: resultId } })).status).toBe('hmis_confirmed');
  });

  it('a lost answer is settled by read-back, never by sending again', async () => {
    await orderReleased();
    stub.faults.transaction = [{ status: 500, apply: true }];
    expect((await deliverOutbox(db, hmis, 'jobs:1'))[0]).toMatchObject({ outcome: 'ambiguous', resultStatus: 'queued' });
    await db.outboxMessage.updateMany({ data: { availableAt: new Date() } });
    expect((await deliverOutbox(db, hmis, 'jobs:1'))[0]).toMatchObject({ outcome: 'confirmed', resultStatus: 'hmis_confirmed' });
    expect(stub.transactions).toHaveLength(1);
  });

  it('when the read-back cannot be made, it waits and asks again rather than resending', async () => {
    await orderReleased();
    stub.faults.transaction = [{ status: 500, apply: true }];
    await deliverOutbox(db, hmis, 'jobs:1');
    stub.faults.search = [{ status: 503 }];
    await db.outboxMessage.updateMany({ data: { availableAt: new Date() } });
    expect((await deliverOutbox(db, hmis, 'jobs:1'))[0]).toMatchObject({ outcome: 'retryable', resultStatus: 'queued' });
    expect(stub.transactions).toHaveLength(1);
    expect((await db.outboxMessage.findFirstOrThrow()).lastError).toMatch(/read-back failed/);
    await db.outboxMessage.updateMany({ data: { availableAt: new Date() } });
    expect((await deliverOutbox(db, hmis, 'jobs:1'))[0]).toMatchObject({ outcome: 'confirmed', resultStatus: 'hmis_confirmed' });
    expect(stub.transactions).toHaveLength(1);
  });

  it('a busy HMIS is tried again no sooner than it asked', async () => {
    await orderReleased();
    stub.faults.transaction = [{ status: 429, headers: { 'retry-after': '600' } }];
    const before = Date.now();
    expect((await deliverOutbox(db, hmis, 'jobs:1'))[0]).toMatchObject({ outcome: 'retryable', resultStatus: 'queued' });
    const row = await db.outboxMessage.findFirstOrThrow();
    expect(row.availableAt.getTime() - before).toBeGreaterThanOrEqual(599_000);
    expect(await deliverOutbox(db, hmis, 'jobs:1')).toEqual([]);
  });

  it('a send left in progress by a stopped worker is picked up when its lease runs out', async () => {
    await orderReleased();
    await db.outboxMessage.updateMany({ data: { status: 'IN_PROGRESS', leasedBy: 'gone:1', leaseUntil: new Date(Date.now() + 60_000) } });
    expect(await deliverOutbox(db, hmis, 'jobs:1')).toEqual([]);
    await db.outboxMessage.updateMany({ data: { leaseUntil: new Date(Date.now() - 1000) } });
    expect((await deliverOutbox(db, hmis, 'jobs:1'))[0]).toMatchObject({ outcome: 'accepted', resultStatus: 'hmis_confirmed' });
  });
});

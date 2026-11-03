import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { acquireLease, createDb, PrismaRawMessageStore, startLinkSession, uuidv7, type Db } from '@lis/db';
import { SimulatedHmis } from '@lis/hmis';
import { accessionSpecimen, approve, correct, deliverOutbox, pullOrders, release, replay, review, verifyAuditChain, WorkflowRejected } from '@lis/lab';
import { runIntakeBatch } from '@lis/result-intake';

const url = process.env['TEST_DATABASE_URL'];
export const ALL_TABLES =
  'audit_event, delivery_attempt, outbox_message, result_event, result_version, result, unmatched_result, specimen, ordered_test, lab_order, patient, hmis_code_map, hmis_cursor, observation, normalized_message, inbox_message, raw_frame, raw_message, link_session, instrument_connection_lease, instrument_verification_evidence, instrument_connection, test_mapping_set, instrument';

const upload = (barcode: string, value = '1.50', extra: string[] = []) =>
  Buffer.from(
    [
      'H|\\^&|||cobas-e411^1|||||host|RSUPL^REAL|P|1',
      'P|1',
      `O|1|${barcode}|40^0^5^^S1^SC|^^^10^|R||||||N||||1|||||||20261103095504|||F`,
      `R|1|^^^10/not|${value}^|uIU/mL||N||F||admin|||E1`,
      ...extra,
      'L|1|N',
    ].map((r) => `${r}\r`).join(''),
    'latin1',
  );

const approver = { username: 'dr.lab', displayName: 'Dr Lab' };

describe.skipIf(!url)('order → specimen → analyzer result → review → approval → release → HMIS', () => {
  let db: Db;
  let hmis: SimulatedHmis;
  let store: PrismaRawMessageStore;

  beforeAll(() => {
    db = createDb(url as string);
  });
  afterAll(async () => {
    await db?.$disconnect();
  });
  beforeEach(async () => {
    await db.$executeRawUnsafe(`TRUNCATE ${ALL_TABLES} CASCADE`);
    hmis = new SimulatedHmis();
    await db.instrument.create({
      data: { id: 'e411-01', displayName: 'e 411', manufacturer: 'Roche', model: 'cobas e 411', softwareVersion: '02-04', discipline: 'immunoassay', createdBy: 'test' },
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

  async function orderAndCollect() {
    hmis.placeOrder({ hmisOrderId: 'ORD-1', patient: { mrn: 'MRN1', familyName: 'Example' }, orderedAt: '2026-11-03T08:15:00+03:00', lines: [{ hmisLineId: '1', testCode: 'HMIS-TSH' }, { hmisLineId: '2', testCode: 'HMIS-FT4' }] });
    expect(await pullOrders(db, hmis)).toEqual({ received: 1, created: 1 });
    expect(await pullOrders(db, hmis)).toEqual({ received: 0, created: 0 }); // cursor advanced
    const order = await db.labOrder.findUniqueOrThrow({ where: { hmisOrderId: 'ORD-1' }, include: { tests: { orderBy: { hmisLineId: 'asc' } } } });
    expect(order.tests.map((t) => t.localTestCode)).toEqual(['TSH', null]); // FT4 has no HMIS code mapping: needs attention
    const { accessionNo } = await accessionSpecimen(db, { orderId: order.id, orderedTestIds: order.tests.map((t) => t.id), user: 'phleb', now: new Date('2026-11-03T08:40:00Z') });
    expect(accessionNo).toBe('L26110300001');
    return accessionNo;
  }

  async function analyse(barcode: string, value?: string) {
    await store.storeAstmTransfer({ text: upload(barcode, value), complete: true, frameCount: 1, receivedAt: new Date() });
    return runIntakeBatch(db, 'jobs:1');
  }

  async function acceptInstrument() {
    await db.instrument.update({ where: { id: 'e411-01' }, data: { enabled: true, verificationStatus: 'LAB_ACCEPTED', verifiedSoftwareVersion: '02-04' } });
  }

  it('runs the whole path and the HMIS confirms the delivered value', async () => {
    const barcode = await orderAndCollect();
    const [o] = await analyse(barcode);
    expect(o).toMatchObject({ status: 'done', matched: 1 });
    const result = await db.result.findFirstOrThrow({ include: { versions: true } });
    expect(result).toMatchObject({ status: 'received', instrumentId: 'e411-01' });

    await review(db, result.id, 'tech.a', 1);
    await expect(approve(db, result.id, 'tech.a', { twoPersonRule: true })).rejects.toThrow(/SAME_PERSON/);
    await approve(db, result.id, 'dr.lab', { twoPersonRule: true });

    // Instrument still unverified: nothing may be released.
    await expect(release(db, result.id, approver)).rejects.toBeInstanceOf(WorkflowRejected);
    await acceptInstrument();
    const { idempotencyKey } = await release(db, result.id, approver);

    const [d] = await deliverOutbox(db, hmis, 'jobs:1');
    expect(d).toMatchObject({ outcome: 'accepted', resultStatus: 'hmis_confirmed' });
    expect(hmis.stored).toHaveLength(1);
    expect(hmis.stored[0]).toMatchObject({ idempotencyKey, hmisOrderId: 'ORD-1', hmisLineId: '1', testCode: 'HMIS-TSH', value: { type: 'numeric', value: '1.50', unit: 'uIU/mL' }, specimen: { accessionNo: barcode }, approvedBy: approver });
    expect((await db.result.findUniqueOrThrow({ where: { id: result.id } })).status).toBe('hmis_confirmed');
    expect(await verifyAuditChain(db)).toMatchObject({ ok: true });
  });

  it('quarantines unknown barcodes and tests that were not ordered', async () => {
    await orderAndCollect();
    const [o] = await analyse('L99999999999');
    expect(o).toMatchObject({ matched: 0 });
    expect(await db.unmatchedResult.findMany({ select: { reason: true } })).toEqual([{ reason: 'UNKNOWN_BARCODE' }]);
  });

  it('a repeat after approval does not change the approved value; it raises an alert', async () => {
    const barcode = await orderAndCollect();
    await analyse(barcode, '1.50');
    const r = await db.result.findFirstOrThrow();
    await review(db, r.id, 'tech.a', 1);
    await approve(db, r.id, 'dr.lab', { twoPersonRule: true });
    await analyse(barcode, '9.90');
    expect(await db.result.findUniqueOrThrow({ where: { id: r.id } })).toMatchObject({ status: 'approved', selectedVersionNo: 1, newDataAfterApproval: true });
  });

  it('settles a lost HMIS response by read-back and never sends twice', async () => {
    const barcode = await orderAndCollect();
    await analyse(barcode);
    await acceptInstrument();
    const r = await db.result.findFirstOrThrow();
    await review(db, r.id, 'tech.a', 1);
    await approve(db, r.id, 'dr.lab', { twoPersonRule: true });
    await release(db, r.id, approver);
    hmis.injectFault({ kind: 'lost-response' });
    expect((await deliverOutbox(db, hmis, 'jobs:1'))[0]?.outcome).toBe('ambiguous');
    await db.outboxMessage.updateMany({ data: { availableAt: new Date() } });
    expect((await deliverOutbox(db, hmis, 'jobs:1'))[0]).toMatchObject({ outcome: 'confirmed', resultStatus: 'hmis_confirmed' });
    expect(hmis.stored).toHaveLength(1);
    expect(await db.deliveryAttempt.count()).toBe(2);
  });

  it('a rejected delivery fails, and a replay with a reason sends it again', async () => {
    const barcode = await orderAndCollect();
    await analyse(barcode);
    await acceptInstrument();
    const r = await db.result.findFirstOrThrow();
    await review(db, r.id, 'tech.a', 1);
    await approve(db, r.id, 'dr.lab', { twoPersonRule: true });
    await release(db, r.id, approver);
    hmis.injectFault({ kind: 'reject', reason: 'unit not allowed' });
    expect((await deliverOutbox(db, hmis, 'jobs:1'))[0]).toMatchObject({ outcome: 'rejected', resultStatus: 'failed' });
    expect((await db.outboxMessage.findFirstOrThrow()).status).toBe('DEAD');
    await replay(db, r.id, 'dr.lab', 'HMIS unit list updated');
    expect((await deliverOutbox(db, hmis, 'jobs:1'))[0]).toMatchObject({ resultStatus: 'hmis_confirmed' });
  });

  it('sends a correction that points at the delivered result', async () => {
    const barcode = await orderAndCollect();
    await analyse(barcode);
    await acceptInstrument();
    const r = await db.result.findFirstOrThrow();
    await review(db, r.id, 'tech.a', 1);
    await approve(db, r.id, 'dr.lab', { twoPersonRule: true });
    const first = await release(db, r.id, approver);
    await deliverOutbox(db, hmis, 'jobs:1');
    await correct(db, r.id, 'dr.lab', { kind: 'numeric', value: '1.05', scale: 2 }, 'wrong sample loaded at position 5', 'uIU/mL');
    await release(db, r.id, approver);
    await deliverOutbox(db, hmis, 'jobs:1');
    expect(hmis.stored[1]).toMatchObject({ status: 'corrected', correctionOf: first.idempotencyKey, reason: 'wrong sample loaded at position 5', value: { value: '1.05' } });
  });

  it('refuses a release written straight into the outbox without approval (T-25)', async () => {
    const barcode = await orderAndCollect();
    await analyse(barcode);
    const r = await db.result.findFirstOrThrow();
    await expect(
      db.$executeRaw`INSERT INTO outbox_message (id, topic, result_id, version_no, idempotency_key, payload) VALUES (${uuidv7()}::uuid, 'hmis.result.submit', ${r.id}::uuid, 1, 'sneaky', '{}'::jsonb)`,
    ).rejects.toThrow(/without approval/);
  });

  it('detects tampering with the audit trail', async () => {
    await orderAndCollect();
    expect(await verifyAuditChain(db)).toMatchObject({ ok: true, count: 2 });
    // Even the owner role cannot UPDATE (trigger); simulate a restore-from-tampered-backup by disabling it.
    await db.$executeRawUnsafe('ALTER TABLE audit_event DISABLE TRIGGER audit_event_append_only');
    await db.$executeRawUnsafe(`UPDATE audit_event SET actor = 'someone-else' WHERE seq = (SELECT min(seq) FROM audit_event)`);
    await db.$executeRawUnsafe('ALTER TABLE audit_event ENABLE TRIGGER audit_event_append_only');
    expect(await verifyAuditChain(db)).toMatchObject({ ok: false });
  });
});

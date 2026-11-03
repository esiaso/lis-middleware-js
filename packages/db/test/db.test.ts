import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { acquireLease, createDb, endLinkSession, isStaleLeaseError, PrismaRawMessageStore, releaseLease, renewLease, startLinkSession, uuidv7, type Db } from '@lis/db';

/**
 * Runs against a real PostgreSQL with the migrations applied (CI job "db").
 * Without TEST_DATABASE_URL these tests are reported as skipped, not passed.
 */
const url = process.env['TEST_DATABASE_URL'];

describe.skipIf(!url)('database: leases, fencing and raw storage', () => {
  let db: Db;
  const instrumentId = 'e411-01';

  beforeAll(async () => {
    db = createDb(url as string);
  });
  afterAll(async () => {
    await db?.$disconnect();
  });
  beforeEach(async () => {
    await db.$executeRawUnsafe(
      'TRUNCATE inbox_message, raw_frame, raw_message, link_session, instrument_connection_lease, instrument_verification_evidence, instrument_connection, test_mapping_set, instrument CASCADE',
    );
    await db.instrument.create({
      data: { id: instrumentId, displayName: 'e 411', manufacturer: 'Roche', model: 'cobas e 411', discipline: 'immunoassay', createdBy: 'test' },
    });
  });

  it('gives the lease to one owner at a time and bumps the epoch on each acquisition (T-09)', async () => {
    const a = await acquireLease(db, instrumentId, 'host-a:1');
    expect(a?.epoch).toBe(1n);
    expect(await acquireLease(db, instrumentId, 'host-b:2')).toBeNull();
    const again = await acquireLease(db, instrumentId, 'host-a:1');
    expect(again?.epoch).toBe(2n);
    expect(await renewLease(db, again!)).toBe(true);
    expect(await renewLease(db, a!)).toBe(false); // old epoch is dead
    await releaseLease(db, again!);
    const b = await acquireLease(db, instrumentId, 'host-b:2');
    expect(b?.epoch).toBe(3n);
  });

  it('stores frames, assembles the transfer, links frames and queues one inbox row', async () => {
    const lease = (await acquireLease(db, instrumentId, 'w:1'))!;
    const session = await startLinkSession(db, lease);
    const store = new PrismaRawMessageStore(db, lease, session);
    await store.storeAstmFrame({ fn: 1, raw: Buffer.from('\x021H|\\^&\x17AA\r\n', 'latin1'), final: false, receivedAt: new Date() });
    await store.storeAstmFrame({ fn: 2, raw: Buffer.from('\x022L|1\x03BB\r\n', 'latin1'), final: true, receivedAt: new Date() });
    const id = await store.storeAstmTransfer({ text: Buffer.from('H|\\^&\rL|1\r', 'latin1'), complete: true, frameCount: 2, receivedAt: new Date() });
    const msg = await db.rawMessage.findUniqueOrThrow({ where: { id }, include: { frames: true } });
    expect(msg).toMatchObject({ protocol: 'astm-e1381', complete: true, transportAck: 'ACKED', leaseEpoch: 1n });
    expect(msg.frames.map((f) => f.seq).sort()).toEqual([1, 2]);
    expect(Buffer.from(msg.bytes).toString('latin1')).toBe('H|\\^&\rL|1\r');
    expect(await db.inboxMessage.findMany({ where: { rawMessageId: id } })).toHaveLength(1);
    await endLinkSession(db, session, 'test');
  });

  it('keeps aborted transfers for audit without queueing them', async () => {
    const lease = (await acquireLease(db, instrumentId, 'w:1'))!;
    const store = new PrismaRawMessageStore(db, lease, await startLinkSession(db, lease));
    const id = await store.storeAstmTransfer({ text: Buffer.from('H|\\^&\r'), complete: false, frameCount: 0, abortedReason: 'receive timeout', receivedAt: new Date() });
    expect(await db.rawMessage.findUniqueOrThrow({ where: { id } })).toMatchObject({ complete: false, abortedReason: 'receive timeout', transportAck: 'NOT_APPLICABLE' });
    expect(await db.inboxMessage.count()).toBe(0);
  });

  it('rejects writes from a worker whose lease was taken over (fencing)', async () => {
    const old = (await acquireLease(db, instrumentId, 'w:1', 1))!;
    const oldStore = new PrismaRawMessageStore(db, old, await startLinkSession(db, old));
    await db.$executeRaw`UPDATE instrument_connection_lease SET lease_until = now() - interval '1 second'`;
    const fresh = (await acquireLease(db, instrumentId, 'w:2'))!;
    expect(fresh.epoch).toBe(2n);
    const err = await oldStore.storeAstmFrame({ fn: 1, raw: Buffer.from('x'), final: true, receivedAt: new Date() }).catch((e: unknown) => e);
    expect(isStaleLeaseError(err)).toBe(true);
    const err2 = await oldStore.storeMllpMessage({ payload: Buffer.from('MSH|'), receivedAt: new Date() }).catch((e: unknown) => e);
    expect(isStaleLeaseError(err2)).toBe(true);
    expect(await db.rawMessage.count()).toBe(0);
    expect(await db.inboxMessage.count()).toBe(0); // the transaction rolled back as a whole
  });

  it('stores MLLP payloads with their inbox row, idempotently keyed by raw message', async () => {
    const lease = (await acquireLease(db, instrumentId, 'w:1'))!;
    const store = new PrismaRawMessageStore(db, lease, await startLinkSession(db, lease));
    const id = await store.storeMllpMessage({ payload: Buffer.from('MSH|^~\\&|A'), receivedAt: new Date() });
    const inbox = await db.inboxMessage.findFirstOrThrow({ where: { externalId: id } });
    expect(inbox).toMatchObject({ source: 'analyzer:e411-01', status: 'PENDING', rawMessageId: id });
    await expect(db.inboxMessage.create({ data: { id: uuidv7(), source: 'analyzer:e411-01', externalId: id } })).rejects.toThrow();
  });

  it('never lets raw evidence be edited or deleted', async () => {
    const lease = (await acquireLease(db, instrumentId, 'w:1'))!;
    const store = new PrismaRawMessageStore(db, lease, await startLinkSession(db, lease));
    const id = await store.storeMllpMessage({ payload: Buffer.from('MSH|^~\\&|A'), receivedAt: new Date() });
    await expect(db.rawMessage.update({ where: { id }, data: { sha256: 'x' } })).rejects.toThrow(/immutable/);
    await expect(db.rawMessage.delete({ where: { id } })).rejects.toThrow(/immutable/);
  });
});

describe('uuidv7', () => {
  it('is a version 7 UUID and sorts by time', () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
  });
});

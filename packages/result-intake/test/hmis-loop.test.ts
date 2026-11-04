import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@lis/db';
import { hmisLinkStatus } from '@lis/lab';
import { SimulatedHmis } from '@lis/hmis';
import { pollEveryMsFromEnv, runHmisLoop } from '@lis/result-intake';

const url = process.env['TEST_DATABASE_URL'];

describe('pollEveryMsFromEnv', () => {
  it('defaults to 30 seconds and refuses odd values', () => {
    expect(pollEveryMsFromEnv({})).toBe(30_000);
    expect(pollEveryMsFromEnv({ LIMS_HMIS_POLL_SECONDS: '60' })).toBe(60_000);
    expect(() => pollEveryMsFromEnv({ LIMS_HMIS_POLL_SECONDS: '5' })).toThrow(/10 to 3600/);
    expect(() => pollEveryMsFromEnv({ LIMS_HMIS_POLL_SECONDS: 'often' })).toThrow(/10 to 3600/);
  });
});

describe.skipIf(!url)('runHmisLoop', () => {
  let db: Db;
  beforeAll(() => {
    db = createDb(url as string);
  });
  afterAll(async () => {
    await db?.$disconnect();
  });
  beforeEach(async () => {
    await db.$executeRawUnsafe('TRUNCATE audit_event, outbox_message, ordered_test, lab_order, patient, hmis_cursor, hmis_poll_status CASCADE');
  });

  it('pulls orders on its timer, keeps going after a failed poll, and stops when asked', async () => {
    const hmis = new SimulatedHmis();
    let calls = 0;
    const pull = hmis.pullOrders.bind(hmis);
    hmis.pullOrders = async (c) => {
      if (calls++ === 0) throw new Error('HMIS down');
      return pull(c);
    };
    hmis.placeOrder({ hmisOrderId: 'ORD-L', patient: { mrn: 'MRN-L' }, orderedAt: '2026-11-04T08:15:00+03:00', lines: [{ hmisLineId: '1', testCode: 'X' }] });
    const ac = new AbortController();
    const errors: string[] = [];
    const pulled: number[] = [];
    const loop = runHmisLoop({ db, hmis, worker: 'jobs:t', signal: ac.signal, pollEveryMs: 50, deliverEveryMs: 50, onPull: (r) => pulled.push(r.received), onError: (what, e) => errors.push(`${what}: ${e.message}`) });
    for (let i = 0; i < 100 && pulled.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    ac.abort();
    await loop;
    expect(errors).toEqual(['orders: HMIS down']);
    expect(pulled).toEqual([1]);
    expect(await db.labOrder.count({ where: { hmisOrderId: 'ORD-L' } })).toBe(1);
    // The failed poll and the one that worked are both recorded for the HMIS link page.
    expect(await db.hmisPollStatus.findUniqueOrThrow({ where: { name: 'orders' } })).toMatchObject({ profile: 'simulated@1', lastReceived: 1, failuresInARow: 0, lastError: 'HMIS down' });
  });

  it('warns when polls keep failing, when they stop, and when released results wait too long', async () => {
    const now = new Date('2026-11-04T12:00:00Z');
    expect(await hmisLinkStatus(db, now)).toMatchObject({ poll: null, warnings: [] });
    await db.hmisPollStatus.create({ data: { name: 'orders', profile: 'fhir-r4@1', lastAttemptAt: new Date('2026-11-04T11:59:30Z'), failuresInARow: 2, lastError: 'HTTP 503' } });
    expect((await hmisLinkStatus(db, now)).warnings).toEqual([]);
    await db.hmisPollStatus.update({ where: { name: 'orders' }, data: { failuresInARow: 3 } });
    expect((await hmisLinkStatus(db, now)).warnings).toEqual([{ kind: 'poll-failing', text: 'the last 3 order polls failed' }]);
    await db.hmisPollStatus.update({ where: { name: 'orders' }, data: { failuresInARow: 0, lastAttemptAt: new Date('2026-11-04T09:00:00Z') } });
    expect((await hmisLinkStatus(db, now)).warnings.map((w) => w.kind)).toEqual(['poll-silent']);
  });
});

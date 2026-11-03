import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { acquireLease, createDb, PrismaRawMessageStore, reapInbox, startLinkSession, uuidv7, type Db } from '@lis/db';
import { runIntakeBatch } from '@lis/result-intake';

const url = process.env['TEST_DATABASE_URL'];

// Synthetic e 411 (cobas® type) upload: one patient sample with a mapped and an unmapped test, then a QC sample.
const E411_UPLOAD = [
  'H|\\^&|||cobas-e411^1|||||host|RSUPL^REAL|P|1',
  'P|1',
  'O|1|L26110300042|40^0^5^^S1^SC|^^^10^|R||||||N||||1|||||||20261103095504|||F',
  'R|1|^^^10/not|1.50^|uIU/mL||N||F||admin|||E1',
  'R|2|^^^999/not|7^|U/L||N||F||admin|||E1',
  'O|2|PreciControl^LOT1|41^0^1^^QC^SC|^^^10^|R||||||Q||||1|||||||20261103095600|||F',
  'R|1|^^^10/not|2.10^|uIU/mL||N||F||admin|||E1',
  'L|1|N',
].map((r) => `${r}\r`).join('');

describe.skipIf(!url)('result intake (jobs worker) against PostgreSQL', () => {
  let db: Db;
  beforeAll(() => {
    db = createDb(url as string);
  });
  afterAll(async () => {
    await db?.$disconnect();
  });
  beforeEach(async () => {
    await db.$executeRawUnsafe(
      'TRUNCATE observation, normalized_message, inbox_message, raw_frame, raw_message, link_session, instrument_connection_lease, instrument_verification_evidence, instrument_connection, test_mapping_set, instrument CASCADE',
    );
  });

  async function instrument(id: string, adapter: string, adapterOptions: object = {}) {
    await db.instrument.create({ data: { id, displayName: id, manufacturer: 'Roche', model: id, discipline: 'immunoassay', createdBy: 'test' } });
    await db.instrumentConnection.create({
      data: { id: uuidv7(), instrumentId: id, configJson: { instrumentId: id, adapter, adapterOptions, transport: { type: 'tcp-client', host: '10.0.0.1', port: 4001 } }, activeFrom: new Date(Date.now() - 60_000), createdBy: 'test' },
    });
    const lease = (await acquireLease(db, id, 'w:1'))!;
    return new PrismaRawMessageStore(db, lease, await startLinkSession(db, lease));
  }

  async function activateMappings(id: string, mappings: object[]) {
    await db.testMappingSet.create({
      data: { id: uuidv7(), instrumentId: id, versionNo: 3, status: 'ACTIVE', createdBy: 'tech', approvedBy: 'director', approvedAt: new Date(), mappingsJson: mappings },
    });
  }

  it('decodes an e 411 upload into samples and observations, maps tests, keeps QC apart', async () => {
    const store = await instrument('e411-01', 'cobas-e411-astm');
    await activateMappings('e411-01', [{ localTestCode: 'TSH', instrumentTestCode: '10', direction: 'both', reportable: true, ruo: false }]);
    await store.storeAstmTransfer({ text: Buffer.from(E411_UPLOAD, 'latin1'), complete: true, frameCount: 1, receivedAt: new Date() });

    const [outcome] = await runIntakeBatch(db, 'jobs:1');
    expect(outcome).toMatchObject({ status: 'done', messages: 2, observations: 3, unmapped: 1 });

    const msgs = await db.normalizedMessage.findMany({ orderBy: { seq: 'asc' }, include: { observations: { orderBy: { seq: 'asc' } } } });
    expect(msgs.map((m) => [m.sampleClass, m.sampleId, m.mappingVersionNo])).toEqual([
      ['patient', 'L26110300042', 3],
      ['qc', 'PreciControl^LOT1', 3], // control name^lot as sent [e411 HIM E-11]
    ]);
    const [tsh, unknown] = msgs[0]!.observations;
    expect(tsh).toMatchObject({ instrumentTestCode: '10', mapping: 'MAPPED', localTestCode: 'TSH', units: 'uIU/mL', value: { kind: 'numeric', value: '1.50', scale: 2 } });
    expect(tsh?.numericValue?.toString()).toBe('1.5');
    expect(unknown).toMatchObject({ instrumentTestCode: '999', mapping: 'UNMAPPED', localTestCode: null });
    expect(msgs[1]!.observations[0]).toMatchObject({ mapping: 'QC', localTestCode: 'TSH' });

    // Nothing left to do, and running again creates no duplicates.
    expect(await runIntakeBatch(db, 'jobs:1')).toEqual([]);
    expect(await db.observation.count()).toBe(3);
    expect((await db.inboxMessage.findFirstOrThrow()).status).toBe('DONE');
  });

  it('marks every observation unmapped when no mapping set is active', async () => {
    const store = await instrument('e411-01', 'cobas-e411-astm');
    await store.storeAstmTransfer({ text: Buffer.from(E411_UPLOAD, 'latin1'), complete: true, frameCount: 1, receivedAt: new Date() });
    await runIntakeBatch(db, 'jobs:1');
    const patient = await db.normalizedMessage.findFirstOrThrow({ where: { sampleClass: 'patient' }, include: { observations: true } });
    expect(patient.mappingVersionNo).toBeNull();
    expect(patient.observations.every((o) => o.mapping === 'UNMAPPED')).toBe(true);
  });

  it('sends messages that can never decode to the failed list, with the reason', async () => {
    const store = await instrument('mr-01', 'mindray-hl7-mllp');
    await store.storeMllpMessage({ payload: Buffer.from([0x4d, 0x53, 0x48, 0xff, 0xfe]), receivedAt: new Date() }); // invalid UTF-8
    const [o] = await runIntakeBatch(db, 'jobs:1');
    expect(o).toMatchObject({ status: 'dead' });
    const row = await db.inboxMessage.findFirstOrThrow();
    expect(row.status).toBe('DEAD');
    expect(row.lastError).toMatch(/decode failed/);
    expect(await db.normalizedMessage.count()).toBe(0);
  });

  it('parks c 111 messages until its parser exists, without losing them', async () => {
    const store = await instrument('c111-01', 'cobas-c111-astm');
    await store.storeAstmTransfer({ text: Buffer.from('H|\\^&\rL|1|N\r', 'latin1'), complete: true, frameCount: 1, receivedAt: new Date() });
    const [o] = await runIntakeBatch(db, 'jobs:1');
    expect(o?.error).toMatch(/c 111 result parser is not built yet/);
    expect(await db.rawMessage.count()).toBe(1);
  });

  it('decodes generic HL7 results with the stored profile', async () => {
    const store = await instrument('coag-01', 'generic-hl7-mllp', { profile: 'generic-hl7-mllp', sampleId: { segment: 'OBR', field: 2 } });
    await store.storeMllpMessage({ payload: Buffer.from('MSH|^~\\&|COAG|LAB|||20261103100000||ORU^R01|C1|P|2.5\rOBR|1|S9\rOBX|1|NM|PT||12.0|s|||||F'), receivedAt: new Date() });
    const [o] = await runIntakeBatch(db, 'jobs:1');
    expect(o).toMatchObject({ status: 'done', messages: 1, observations: 1, unmapped: 1 });
    expect((await db.normalizedMessage.findFirstOrThrow()).adapterName).toBe('generic-hl7-mllp');
  });

  it('returns rows from a crashed worker to the queue (reaper)', async () => {
    const store = await instrument('e411-01', 'cobas-e411-astm');
    await store.storeAstmTransfer({ text: Buffer.from(E411_UPLOAD, 'latin1'), complete: true, frameCount: 1, receivedAt: new Date() });
    await db.$executeRaw`UPDATE inbox_message SET status = 'IN_PROGRESS', leased_by = 'dead:1', lease_until = now() - interval '1 second', attempts = 1`;
    expect(await runIntakeBatch(db, 'jobs:2')).toEqual([]);
    expect(await reapInbox(db)).toBe(1);
    await db.$executeRaw`UPDATE inbox_message SET available_at = now()`;
    const [o] = await runIntakeBatch(db, 'jobs:2');
    expect(o?.status).toBe('done');
  });
});

import net from 'node:net';
import { once } from 'node:events';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AstmDecoder, AstmLink, E411_DEFAULT_TIMINGS, type LinkAction } from '@lis/protocol-astm';
import { MllpDecoder, mllpWrap } from '@lis/protocol-hl7v2';
import { createDb, uuidv7, type Db } from '@lis/db';
import { runWorker, type Logger } from '@lis/analyzer-worker';

const url = process.env['TEST_DATABASE_URL'];
const quiet: Logger = { info: () => {}, warn: () => {}, error: () => {} };

async function freePort(): Promise<number> {
  const s = net.createServer().listen(0, '127.0.0.1');
  await once(s, 'listening');
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

async function until(cond: () => Promise<boolean> | boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe.skipIf(!url)('analyzer worker against PostgreSQL', () => {
  let db: Db;
  beforeAll(() => {
    db = createDb(url as string);
  });
  afterAll(async () => {
    await db?.$disconnect();
  });
  beforeEach(async () => {
    await db.$executeRawUnsafe(
      'TRUNCATE inbox_message, raw_frame, raw_message, link_session, instrument_connection_lease, instrument_verification_evidence, instrument_connection, test_mapping_set, instrument CASCADE',
    );
  });

  async function register(id: string, adapter: string, transport: object, adapterOptions: object = {}) {
    await db.instrument.create({ data: { id, displayName: id, manufacturer: 'X', model: 'Y', discipline: 'chemistry', createdBy: 'test' } });
    await db.instrumentConnection.create({
      data: { id: uuidv7(), instrumentId: id, configJson: { instrumentId: id, adapter, adapterOptions, transport }, activeFrom: new Date(Date.now() - 1000), createdBy: 'test' },
    });
  }

  /** Device server with an "analyzer" behind it speaking E1381. */
  async function astmAnalyzer() {
    const link = new AstmLink(E411_DEFAULT_TIMINGS, 'packed');
    const dec = new AstmDecoder();
    const sent: string[] = [];
    let sock: net.Socket | undefined;
    const run = (as: LinkAction[]) => {
      for (const a of as) {
        if (a.type === 'write') sock?.write(a.bytes);
        if (a.type === 'sent') sent.push(a.id);
      }
    };
    const server = net.createServer((s) => {
      sock = s;
      s.on('error', () => {});
      s.on('data', (d) => dec.push(d).forEach((u) => run(link.onUnit(u, Date.now()))));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const t = setInterval(() => run(link.onTick(Date.now())), 10);
    return {
      port: (server.address() as net.AddressInfo).port,
      link,
      sent,
      connected: () => sock !== undefined,
      close: () => {
        clearInterval(t);
        sock?.destroy();
        return new Promise<void>((r) => server.close(() => r()));
      },
    };
  }

  it('stores an e 411 upload with its inbox row, and releases the lease on stop', async () => {
    const an = await astmAnalyzer();
    await register('e411-01', 'cobas-e411-astm', { type: 'tcp-client', host: '127.0.0.1', port: an.port, reconnectMinMs: 50, reconnectMaxMs: 100 });
    const ac = new AbortController();
    const done = runWorker({ db, instrumentId: 'e411-01', owner: 'test:1', logger: quiet, signal: ac.signal, renewEveryMs: 100 });
    await until(an.connected);
    an.link.enqueue({ id: 'm1', body: Buffer.from('H|\\^&|||cobas-e411^1\rP|1\rO|1|L1\rR|1|^^^10^|1.5|uIU/mL||N||F\rL|1|N\r', 'latin1') });
    await until(async () => (await db.inboxMessage.count()) === 1);
    expect(an.sent).toEqual(['m1']);
    const raw = await db.rawMessage.findFirstOrThrow();
    expect(raw).toMatchObject({ protocol: 'astm-e1381', complete: true, instrumentId: 'e411-01' });

    ac.abort();
    expect(await done).toEqual({ reason: 'stopped' });
    const lease = await db.instrumentConnectionLease.findUniqueOrThrow({ where: { instrumentId: 'e411-01' } });
    expect(lease.leaseUntil.getTime()).toBeLessThanOrEqual(Date.now());
    expect((await db.linkSession.findFirstOrThrow()).endReason).toBe('stopped');
    await an.close();
  });

  it('refuses to start while another worker holds the lease (T-09)', async () => {
    const an = await astmAnalyzer();
    await register('e411-01', 'cobas-e411-astm', { type: 'tcp-client', host: '127.0.0.1', port: an.port });
    const ac = new AbortController();
    const first = runWorker({ db, instrumentId: 'e411-01', owner: 'host-a:1', logger: quiet, signal: ac.signal, renewEveryMs: 100 });
    await until(an.connected);
    const second = await runWorker({ db, instrumentId: 'e411-01', owner: 'host-b:2', logger: quiet, signal: new AbortController().signal });
    expect(second).toMatchObject({ reason: 'lease-held' });
    ac.abort();
    await first;
    await an.close();
  });

  it('stops at once when the lease is taken over', async () => {
    const an = await astmAnalyzer();
    await register('e411-01', 'cobas-e411-astm', { type: 'tcp-client', host: '127.0.0.1', port: an.port });
    const run = runWorker({ db, instrumentId: 'e411-01', owner: 'host-a:1', logger: quiet, signal: new AbortController().signal, renewEveryMs: 50 });
    await until(an.connected);
    await db.$executeRaw`UPDATE instrument_connection_lease SET owner = 'host-z:9', epoch = epoch + 1`;
    expect(await run).toEqual({ reason: 'lease-lost' });
    await an.close();
  });

  it('acknowledges HL7 from a generic-profile instrument only after storing it', async () => {
    const port = await freePort();
    await register(
      'coag-01',
      'generic-hl7-mllp',
      { type: 'tcp-server', bindAddress: '127.0.0.1', port, allowedPeers: ['127.0.0.1'] },
      { profile: 'generic-hl7-mllp', sampleId: { segment: 'OBR', field: 2 } },
    );
    const ac = new AbortController();
    const done = runWorker({ db, instrumentId: 'coag-01', owner: 'test:1', logger: quiet, signal: ac.signal, renewEveryMs: 100 });
    let client: net.Socket | undefined;
    await until(async () => {
      try {
        client = net.connect(port, '127.0.0.1');
        client.on('error', () => {});
        await once(client, 'connect');
        return true;
      } catch {
        return false;
      }
    });
    const acks: string[] = [];
    const dec = new MllpDecoder();
    client!.on('data', (d) => dec.push(d).forEach((u) => u.type === 'message' && acks.push(u.payload.toString())));
    client!.write(mllpWrap(Buffer.from('MSH|^~\\&|COAG|LAB|||20261103100000||ORU^R01|C1|P|2.5\rOBR|1|S1\rOBX|1|NM|PT||12.0|s|||||F')));
    await until(() => acks.length === 1);
    expect(acks[0]).toContain('MSA|AA|C1');
    expect(await db.inboxMessage.count()).toBe(1);
    client!.destroy();
    ac.abort();
    await done;
  });

  it('reports an unregistered instrument instead of opening anything', async () => {
    expect(await runWorker({ db, instrumentId: 'nope-01', owner: 't', logger: quiet, signal: new AbortController().signal })).toMatchObject({ reason: 'not-configured' });
  });
});

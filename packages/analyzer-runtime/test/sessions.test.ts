import net from 'node:net';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { AstmDecoder, AstmLink, type AstmLinkTimings, type LinkAction } from '@lis/protocol-astm';
import { MllpDecoder, mllpWrap } from '@lis/protocol-hl7v2';
import { TcpClientTransport, TcpServerTransport } from '@lis/transport';
import { AstmSession, MllpSession, type AstmTransferRecord, type RawMessageStore } from '@lis/analyzer-runtime';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** Short timers so retry paths run quickly; same structure as the E1381 defaults. */
const FAST: AstmLinkTimings = { replyTimeoutMs: 500, busyRetryDelayMs: 50, maxRetries: 6, receiveTimeoutMs: 500, contentionBackoffMs: 20 };

class MemoryStore implements RawMessageStore {
  frames: Buffer[] = [];
  transfers: AstmTransferRecord[] = [];
  mllp: Buffer[] = [];
  failNext = 0;
  log: string[] = [];
  async storeAstmFrame(f: { raw: Buffer; fn: number }) {
    if (this.failNext-- > 0) throw new Error('database unavailable');
    await new Promise((r) => setTimeout(r, 2)); // a real commit takes time
    this.frames.push(f.raw);
    this.log.push(`stored ${f.fn}`);
  }
  async storeAstmTransfer(t: AstmTransferRecord) {
    this.transfers.push(t);
    return `raw-${this.transfers.length}`;
  }
  async storeMllpMessage(m: { payload: Buffer }) {
    if (this.failNext-- > 0) throw new Error('database unavailable');
    this.mllp.push(m.payload);
    return `raw-${this.mllp.length}`;
  }
}

/** Plays the analyzer behind a device server: its own AstmLink over a real socket. */
async function astmInstrument() {
  const link = new AstmLink(FAST, 'packed');
  const decoder = new AstmDecoder();
  const sentIds: string[] = [];
  const received: Buffer[] = [];
  const inbound: Buffer[] = [];
  let socket: net.Socket | undefined;
  const run = (actions: LinkAction[]) => {
    for (const a of actions) {
      if (a.type === 'write') {
        if (a.note.startsWith('ACK') || a.note.startsWith('NAK')) received.push(a.bytes);
        socket?.write(a.bytes);
      }
      if (a.type === 'frame') run(link.commitFrame(true, Date.now()));
      if (a.type === 'sent') sentIds.push(a.id);
      if (a.type === 'transfer-complete') inbound.push(a.text);
    }
  };
  const server = net.createServer((s) => {
    socket = s;
    s.on('error', () => {});
    s.on('data', (d) => {
      for (const u of decoder.push(d)) run(link.onUnit(u, Date.now()));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const timer = setInterval(() => run(link.onTick(Date.now())), 10);
  cleanups.push(() => {
    clearInterval(timer);
    socket?.destroy();
    return new Promise<void>((r) => server.close(() => r()));
  });
  return { port: (server.address() as net.AddressInfo).port, link, sentIds, inbound, connected: () => socket !== undefined };
}

async function until(cond: () => boolean, ms = 4000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const RESULT = Buffer.from(
  ['H|\\^&|||SIM^1', 'P|1', 'O|1|L26110300042', ...Array.from({ length: 30 }, (_, i) => `R|${i + 1}|^^^T${i}|${i}.5|u||N||F`), 'L|1|N']
    .map((r) => `${r}\r`)
    .join(''),
  'latin1',
);

describe('AstmSession over TCP', () => {
  async function host(store: MemoryStore, onTransfer?: ConstructorParameters<typeof AstmSession>[0]['onTransfer']) {
    const inst = await astmInstrument();
    const transport = new TcpClientTransport({ host: '127.0.0.1', port: inst.port, connectTimeoutMs: 1000, keepAliveMs: 30000, reconnectMinMs: 20, reconnectMaxMs: 50 });
    const events: string[] = [];
    const session = new AstmSession({ transport, store, timings: FAST, onEvent: (e) => events.push(e.code), ...(onTransfer ? { onTransfer } : {}) });
    cleanups.push(() => session.stop('test end'));
    await session.start();
    await until(inst.connected);
    return { inst, session, events };
  }

  it('stores every frame before ACK and hands over the assembled transfer', async () => {
    const store = new MemoryStore();
    const { inst } = await host(store);
    inst.link.enqueue({ id: 'm1', body: RESULT });
    await until(() => inst.sentIds.includes('m1') && store.transfers.length === 1);
    expect(store.frames.length).toBeGreaterThan(1); // multi-frame message
    expect(store.transfers[0]).toMatchObject({ complete: true });
    expect(store.transfers[0]?.text.equals(RESULT)).toBe(true);
  });

  it('NAKs while the database is down; the instrument retries and nothing is lost', async () => {
    const store = new MemoryStore();
    store.failNext = 2;
    const { inst, events } = await host(store);
    inst.link.enqueue({ id: 'm2', body: RESULT });
    await until(() => inst.sentIds.includes('m2') && store.transfers.length === 1);
    expect(events.filter((e) => e === 'store-failed')).toHaveLength(2);
    expect(store.transfers[0]?.text.equals(RESULT)).toBe(true);
  });

  it('sends the reply returned for a stored transfer (query answer path)', async () => {
    const store = new MemoryStore();
    const replies: string[] = [];
    const { inst } = await host(store, (id) => {
      replies.push(id);
      return { id: 'reply-1', body: Buffer.from('H|\\^&\rL|1|N\r', 'latin1') };
    });
    inst.link.enqueue({ id: 'q1', body: Buffer.from('H|\\^&\rQ|1|^SID1||ALL\rL|1|N\r', 'latin1') });
    await until(() => replies.length === 1);
    await until(() => inst.inbound.length === 1);
    expect(replies).toEqual(['raw-1']);
    expect(inst.inbound[0]?.toString('latin1')).toBe('H|\\^&\rL|1|N\r');
  });
});

describe('MllpSession over TCP', () => {
  async function setup(store: MemoryStore) {
    const transport = new TcpServerTransport({ bindAddress: '127.0.0.1', port: 0, allowedPeers: ['127.0.0.1'] });
    const session = new MllpSession({ transport, store, onMessage: (id) => Buffer.from(`MSH|^~\\&|LIS\rMSA|AA|${id}`) });
    cleanups.push(() => session.stop('test end'));
    await session.start();
    const client = net.connect(transport.boundPort as number, '127.0.0.1');
    client.on('error', () => {});
    await once(client, 'connect');
    cleanups.push(() => void client.destroy());
    const acks: string[] = [];
    const dec = new MllpDecoder();
    client.on('data', (d) => {
      for (const u of dec.push(d)) if (u.type === 'message') acks.push(u.payload.toString());
    });
    return { client, acks, session };
  }

  it('acknowledges each stored block, including two blocks in one write', async () => {
    const store = new MemoryStore();
    const { client, acks } = await setup(store);
    client.write(Buffer.concat([mllpWrap(Buffer.from('MSH|^~\\&|A\rOBX|1')), mllpWrap(Buffer.from('MSH|^~\\&|B\rOBX|1'))]));
    await until(() => acks.length === 2);
    expect(store.mllp.map((p) => p.toString().split('\r')[0])).toEqual(['MSH|^~\\&|A', 'MSH|^~\\&|B']);
    expect(acks[0]).toContain('MSA|AA|raw-1');
  });

  it('sends no ACK when the payload could not be stored', async () => {
    const store = new MemoryStore();
    store.failNext = 1;
    const { client, acks, session } = await setup(store);
    client.write(mllpWrap(Buffer.from('MSH|^~\\&|A')));
    await new Promise((r) => setTimeout(r, 100));
    await session.idle();
    expect(acks).toEqual([]);
    client.write(mllpWrap(Buffer.from('MSH|^~\\&|A'))); // instrument resends
    await until(() => acks.length === 1);
  });
});

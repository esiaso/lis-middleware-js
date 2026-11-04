import net from 'node:net';
import type { Duplex } from 'node:stream';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { MockBinding } from '@serialport/binding-mock';
import { createTransport, backoffDelay, SerialTransport, SupervisedStreamTransport, TcpClientTransport, TcpServerTransport, TransportNotOpenError, type Transport, type TransportState } from '@lis/transport';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function waitState(t: Transport, s: TransportState, timeoutMs = 3000): Promise<void> {
  if (t.state === s) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${s}, now ${t.state}`)), timeoutMs);
    const fn = (st: TransportState) => {
      if (st === s) {
        clearTimeout(timer);
        t.off('state', fn);
        resolve();
      }
    };
    t.on('state', fn);
  });
}

async function listen(onSocket: (s: net.Socket) => void): Promise<{ server: net.Server; port: number }> {
  const server = net.createServer((sock) => {
    sock.on('error', () => {}); // resets from the transport side are expected in these tests
    onSocket(sock);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  return { server, port: (server.address() as net.AddressInfo).port };
}

const fast = { connectTimeoutMs: 1000, keepAliveMs: 30000, reconnectMinMs: 20, reconnectMaxMs: 80, random: () => 0 };

describe('backoffDelay', () => {
  it('grows exponentially, capped, with jitter inside the window', () => {
    expect(backoffDelay(0, 1000, 60000, () => 1)).toBe(1000);
    expect(backoffDelay(3, 1000, 60000, () => 1)).toBe(8000);
    expect(backoffDelay(20, 1000, 60000, () => 1)).toBe(60000);
    expect(backoffDelay(20, 1000, 60000, () => 0)).toBe(1000);
  });
});

describe('TcpClientTransport', () => {
  it('connects, exchanges bytes, and reconnects after the device server drops', async () => {
    const sockets: net.Socket[] = [];
    const received: Buffer[] = [];
    const { port } = await listen((s) => {
      sockets.push(s);
      s.on('data', (d) => received.push(d));
      s.write(Buffer.from([0x05])); // ENQ from the "analyzer"
    });
    const t = new TcpClientTransport({ host: '127.0.0.1', port, ...fast });
    cleanups.push(() => t.close('test end'));
    const data = once(t, 'data');
    await t.open();
    await waitState(t, 'open');
    expect((await data)[0]).toEqual(Buffer.from([0x05]));
    await t.write(Buffer.from([0x06]));
    await new Promise((r) => setTimeout(r, 30));
    expect(Buffer.concat(received)).toEqual(Buffer.from([0x06]));

    sockets[0]?.destroy(); // device server restart
    await waitState(t, 'backoff');
    await waitState(t, 'open');
    expect(sockets).toHaveLength(2);
  });

  it('when closed mid-connect, waits for that attempt and reports nothing after', async () => {
    // A connect that fails only after close() was called (a slow refusal, as on Windows).
    class SlowRefusal extends SupervisedStreamTransport {
      readonly kind = 'tcp-client' as const;
      protected connectOnce(): Promise<Duplex> {
        return new Promise((_, reject) => setTimeout(() => reject(new Error('ECONNREFUSED')), 50));
      }
    }
    const t = new SlowRefusal({ reconnectMinMs: 10, reconnectMaxMs: 20 });
    const errors: Error[] = [];
    t.on('error', (e) => errors.push(e));
    await t.open();
    await waitState(t, 'connecting');
    await t.close('done');
    expect(t.state).toBe('closed');
    await new Promise((r) => setTimeout(r, 100));
    expect(errors).toHaveLength(0);
    expect(t.state).toBe('closed');
  });

  it('keeps retrying while nothing listens, and stops when closed', async () => {
    const probe = net.createServer().listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const port = (probe.address() as net.AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    const t = new TcpClientTransport({ host: '127.0.0.1', port, ...fast });
    const errors: Error[] = [];
    t.on('error', (e) => errors.push(e));
    await t.open();
    await new Promise((r) => setTimeout(r, 200));
    expect(errors.length).toBeGreaterThanOrEqual(2);
    await expect(t.write(Buffer.from('x'))).rejects.toBeInstanceOf(TransportNotOpenError);
    await t.close('done');
    expect(t.state).toBe('closed');
    const n = errors.length;
    await new Promise((r) => setTimeout(r, 150));
    expect(errors.length).toBe(n);
  });

  it('applies backpressure: no data events while paused', async () => {
    let peer: net.Socket | undefined;
    const { port } = await listen((s) => (peer = s));
    const t = new TcpClientTransport({ host: '127.0.0.1', port, ...fast });
    cleanups.push(() => t.close('test end'));
    const chunks: Buffer[] = [];
    t.on('data', (c) => chunks.push(c));
    await t.open();
    await waitState(t, 'open');
    t.pause();
    peer?.write('abc');
    await new Promise((r) => setTimeout(r, 50));
    expect(chunks).toHaveLength(0);
    t.resume();
    await new Promise((r) => setTimeout(r, 50));
    expect(Buffer.concat(chunks).toString()).toBe('abc');
  });
});

describe('TcpServerTransport', () => {
  async function server(allowed: string[]) {
    const t = new TcpServerTransport({ bindAddress: '127.0.0.1', port: 0, allowedPeers: allowed });
    cleanups.push(() => t.close('test end'));
    await t.open();
    return t;
  }
  const dial = async (port: number) => {
    const s = net.connect(port, '127.0.0.1');
    s.on('error', () => {});
    await once(s, 'connect');
    cleanups.push(() => void s.destroy());
    return s;
  };

  it('refuses peers that are not on the allow-list', async () => {
    const t = await server(['10.20.5.30']);
    const rejected = once(t, 'peer-rejected');
    await dial(t.boundPort as number);
    expect(await rejected).toEqual(['127.0.0.1', 'not-allowed']);
    expect(t.state).toBe('listening');
  });

  it('accepts one allowed peer at a time and goes back to listening when it leaves', async () => {
    const t = await server(['127.0.0.1']);
    const port = t.boundPort as number;
    const a = await dial(port);
    await waitState(t, 'open');
    const rejected = once(t, 'peer-rejected');
    await dial(port);
    expect((await rejected)[1]).toBe('already-connected');

    const got = once(t, 'data');
    a.write('MSH|');
    expect((await got)[0].toString()).toBe('MSH|');
    const back = new Promise<Buffer>((r) => a.once('data', r));
    await t.write(Buffer.from('ACK'));
    expect((await back).toString()).toBe('ACK');

    a.destroy();
    await waitState(t, 'listening');
    await expect(t.write(Buffer.from('x'))).rejects.toBeInstanceOf(TransportNotOpenError);
  });
});

describe('SerialTransport (mock binding)', () => {
  it('opens with the configured line settings and passes bytes both ways', async () => {
    MockBinding.reset();
    MockBinding.createPort('/dev/ttyMOCK0', { echo: true });
    const t = new SerialTransport({ path: '/dev/ttyMOCK0', baudRate: 9600, dataBits: 8, parity: 'none', stopBits: 1, flowControl: 'xonxoff', reconnectMinMs: 20, reconnectMaxMs: 50, binding: MockBinding });
    cleanups.push(() => t.close('test end'));
    await t.open();
    await waitState(t, 'open');
    const echoed = once(t, 'data');
    await t.write(Buffer.from([0x06]));
    expect((await echoed)[0]).toEqual(Buffer.from([0x06]));
  });

  it('retries opening a port that does not exist yet', async () => {
    MockBinding.reset();
    const t = createTransport({ type: 'serial', path: '/dev/ttyMOCK9', baudRate: 9600, dataBits: 8, parity: 'none', stopBits: 1, flowControl: 'none' }, { serialBinding: MockBinding });
    const errors: Error[] = [];
    t.on('error', (e) => errors.push(e));
    cleanups.push(() => t.close('test end'));
    await t.open();
    await waitState(t, 'backoff');
    expect(errors[0]?.message).toMatch(/does not exist|not found|No such/i);
  });
});

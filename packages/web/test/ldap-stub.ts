import { createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';

/**
 * A tiny stand-in directory for tests: plain LDAP (no TLS) on loopback,
 * enough of RFC 4511 for simple bind, a subtree search with and/or/equality/
 * present filters, and unbind. It is not a directory product and says
 * nothing about how any real one behaves beyond the protocol.
 */
export interface StubEntry {
  dn: string;
  password: string;
  attrs: Record<string, string[]>;
}

type Filter = { and: Filter[] } | { or: Filter[] } | { eq: [string, string] } | { present: string };

export interface StubDirectory {
  url: string;
  entries: StubEntry[];
  service: { dn: string; password: string };
  /** Refuse every connection (the directory is down). */
  down: boolean;
  binds: string[];
  filters: Filter[];
  close(): Promise<void>;
}

const len = (n: number) => (n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 0xff]));
const tlv = (tag: number, content: Buffer) => Buffer.concat([Buffer.from([tag]), len(content.length), content]);
const int = (tag: number, n: number) => tlv(tag, n < 0x80 ? Buffer.from([n]) : Buffer.from([n >> 8, n & 0xff]));
const str = (s: string, tag = 0x04) => tlv(tag, Buffer.from(s, 'utf8'));
const result = (tag: number, code: number) => tlv(tag, Buffer.concat([int(0x0a, code), str(''), str('')]));

function read(buf: Buffer, at: number): { tag: number; start: number; end: number } | null {
  if (at + 2 > buf.length) return null;
  const tag = buf[at]!;
  let l = buf[at + 1]!;
  let start = at + 2;
  if (l & 0x80) {
    const n = l & 0x7f;
    if (start + n > buf.length) return null;
    l = 0;
    for (let i = 0; i < n; i++) l = (l << 8) | buf[start + i]!;
    start += n;
  }
  if (start + l > buf.length) return null;
  return { tag, start, end: start + l };
}

function children(buf: Buffer, start: number, end: number) {
  const out: { tag: number; start: number; end: number }[] = [];
  for (let at = start; at < end; ) {
    const t = read(buf, at)!;
    out.push(t);
    at = t.end;
  }
  return out;
}

const num = (buf: Buffer, t: { start: number; end: number }) => {
  let n = 0;
  for (let i = t.start; i < t.end; i++) n = (n << 8) | buf[i]!;
  return n;
};
const text = (buf: Buffer, t: { start: number; end: number }) => buf.subarray(t.start, t.end).toString('utf8');

function parseFilter(buf: Buffer, t: { tag: number; start: number; end: number }): Filter {
  if (t.tag === 0xa0) return { and: children(buf, t.start, t.end).map((c) => parseFilter(buf, c)) };
  if (t.tag === 0xa1) return { or: children(buf, t.start, t.end).map((c) => parseFilter(buf, c)) };
  if (t.tag === 0xa3) {
    const [a, v] = children(buf, t.start, t.end);
    return { eq: [text(buf, a!), text(buf, v!)] };
  }
  if (t.tag === 0x87) return { present: text(buf, t) };
  throw new Error(`stub directory: filter tag 0x${t.tag.toString(16)} not supported`);
}

function matches(f: Filter, e: StubEntry): boolean {
  const get = (name: string) => Object.entries(e.attrs).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1] ?? [];
  if ('and' in f) return f.and.every((x) => matches(x, e));
  if ('or' in f) return f.or.some((x) => matches(x, e));
  if ('present' in f) return f.present.toLowerCase() === 'objectclass' || get(f.present).length > 0;
  return get(f.eq[0]).some((v) => v.toLowerCase() === f.eq[1].toLowerCase());
}

export async function startStubDirectory(entries: StubEntry[], service = { dn: 'cn=lims,ou=services,dc=example,dc=test', password: 'service-secret' }): Promise<StubDirectory> {
  const sockets = new Set<Socket>();
  const stub = { entries, service, down: false, binds: [] as string[], filters: [] as Filter[] } as StubDirectory;
  const server: Server = createServer((socket) => {
    if (stub.down) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    let pending = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        const msg = read(pending, 0);
        if (!msg) break;
        const [id, op] = children(pending, msg.start, msg.end);
        const reply = (body: Buffer) => socket.write(tlv(0x30, Buffer.concat([int(0x02, num(pending, id!)), body])));
        if (op!.tag === 0x60) {
          const [, name, auth] = children(pending, op!.start, op!.end);
          const dn = text(pending, name!);
          const pw = text(pending, auth!);
          stub.binds.push(dn);
          const ok = (dn === service.dn && pw === service.password) || (pw !== '' && entries.some((e) => e.dn.toLowerCase() === dn.toLowerCase() && e.password === pw)) || (dn === '' && pw === '') || (pw === '' && dn !== '');
          reply(result(0x61, ok ? 0 : 49));
        } else if (op!.tag === 0x63) {
          const [base, , , size, , , filter, attrs] = children(pending, op!.start, op!.end);
          const f = parseFilter(pending, filter!);
          stub.filters.push(f);
          const baseDn = text(pending, base!).toLowerCase();
          const wanted = children(pending, attrs!.start, attrs!.end).map((a) => text(pending, a).toLowerCase());
          const hits = entries.filter((e) => e.dn.toLowerCase().endsWith(baseDn) && matches(f, e));
          const limit = num(pending, size!);
          for (const e of limit ? hits.slice(0, limit) : hits) {
            const list = Object.entries(e.attrs).filter(([k]) => !wanted.length || wanted.includes(k.toLowerCase()));
            reply(tlv(0x64, Buffer.concat([str(e.dn), tlv(0x30, Buffer.concat(list.map(([k, vs]) => tlv(0x30, Buffer.concat([str(k), tlv(0x31, Buffer.concat(vs.map((v) => str(v))))])))))])));
          }
          reply(result(0x65, limit && hits.length > limit ? 4 : 0));
        } else if (op!.tag === 0x42) {
          socket.end();
        }
        pending = pending.subarray(msg.end);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  stub.url = `ldap://127.0.0.1:${(server.address() as AddressInfo).port}`;
  stub.close = () =>
    new Promise<void>((resolve) => {
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    });
  return stub;
}

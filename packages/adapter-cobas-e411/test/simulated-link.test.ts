import { describe, expect, it } from 'vitest';
import { AstmDecoder, AstmLink, type LinkAction } from '@lis/protocol-astm';
import { E411Options, parseE411Transfer } from '@lis/adapter-cobas-e411';

/**
 * Two AstmLink instances wired back to back: one plays the analyzer
 * (sender), one plays the middleware (receiver). Bytes cross through
 * AstmDecoders in randomly sized chunks to model TCP via a device server.
 */
function rng(seed: number) {
  let s = seed;
  return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

function run(seed: number, failFirstCommits: number) {
  const rand = rng(seed);
  const instrument = new AstmLink(undefined, 'packed');
  const host = new AstmLink();
  const toHost = new AstmDecoder();
  const toInstrument = new AstmDecoder();
  const stored: Buffer[] = [];
  const transfers: Buffer[] = [];
  let failures = failFirstCommits;
  let now = 0;
  let sent = false;

  const chunk = (b: Buffer): Buffer[] => {
    const out: Buffer[] = [];
    let i = 0;
    while (i < b.length) {
      const n = 1 + Math.floor(rand() * 40);
      out.push(b.subarray(i, i + n));
      i += n;
    }
    return out;
  };

  const handleHost = (actions: LinkAction[]): void => {
    for (const a of actions) {
      if (a.type === 'write') for (const c of chunk(a.bytes)) for (const u of toInstrument.push(c)) handleInstrument(instrument.onUnit(u, now));
      if (a.type === 'frame') {
        const ok = failures-- <= 0; // simulate DB unavailable for the first N commits
        if (ok) stored.push(a.raw);
        handleHost(host.commitFrame(ok, now));
      }
      if (a.type === 'transfer-complete') transfers.push(a.text);
    }
  };
  const handleInstrument = (actions: LinkAction[]): void => {
    for (const a of actions) {
      if (a.type === 'write') for (const c of chunk(a.bytes)) for (const u of toHost.push(c)) handleHost(host.onUnit(u, now));
      if (a.type === 'sent') sent = true;
    }
  };

  const records = [
    'H|\\^&|||cobas-e411^1|||||host|RSUPL^REAL|P|1',
    'P|1',
    'O|1|000004|40^0^5^^S1^SC|^^^10^|R||||||N||||1|||||||20051220095504|||F',
    ...Array.from({ length: 12 }, (_, i) => `R|${i + 1}|^^^${10 + i}//not|1.${i}5^|ulU/ml||N||F||admin|||E1`),
    'L|1|N',
  ];
  const body = Buffer.from(records.map((r) => `${r}\r`).join(''), 'latin1');
  instrument.enqueue({ id: 'r1', body });
  for (let step = 0; step < 200 && !sent; step++) {
    handleInstrument(instrument.onTick(now));
    handleHost(host.onTick(now));
    now += 1000;
  }
  return { sent, transfers, stored, body };
}

describe('simulated e 411 result upload over a chunked link', () => {
  for (const seed of [1, 7, 42, 1234, 99999]) {
    it(`delivers the message intact (seed ${seed})`, () => {
      const { sent, transfers, body } = run(seed, 0);
      expect(sent).toBe(true);
      expect(transfers).toHaveLength(1);
      expect(transfers[0]!.equals(body)).toBe(true);
      const parsed = parseE411Transfer(transfers[0]!, E411Options.parse({}), {
        rawMessageId: '0190f6a2-7c1e-7d8a-9b3c-123456789abc',
        instrumentId: 'e411-01',
        receivedAt: '2026-11-03T10:00:00Z',
      });
      expect(parsed.results[0]?.observations).toHaveLength(12);
    });
  }

  it('recovers when storage fails for some frames: NAK, instrument resends, nothing lost or duplicated', () => {
    const { sent, transfers, body } = run(5, 3);
    expect(sent).toBe(true);
    expect(transfers[0]!.equals(body)).toBe(true);
  });
});

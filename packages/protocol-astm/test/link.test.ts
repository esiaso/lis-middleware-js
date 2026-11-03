import { describe, expect, it } from 'vitest';
import {
  ACK,
  AstmDecoder,
  AstmLink,
  E411_DEFAULT_TIMINGS,
  ENQ,
  EOT,
  NAK,
  encodeFrame,
  encodeMessageFrames,
  type DecodedUnit,
  type LinkAction,
} from '@lis/protocol-astm';

const ctl = (char: 'ENQ' | 'ACK' | 'NAK' | 'EOT'): DecodedUnit => ({ type: 'control', char });
const frameUnit = (fn: number, text: string, final = true): DecodedUnit => {
  const [u] = new AstmDecoder().push(encodeFrame(fn, Buffer.from(text, 'latin1'), final));
  return u!;
};
const writes = (a: LinkAction[]) => a.flatMap((x) => (x.type === 'write' ? [...x.bytes] : []));
const ofType = <T extends LinkAction['type']>(a: LinkAction[], t: T) => a.filter((x): x is Extract<LinkAction, { type: T }> => x.type === t);

describe('AstmLink as receiver', () => {
  it('ACKs ENQ, defers frame ACK until the driver confirms storage, and assembles the transfer on EOT', () => {
    const link = new AstmLink();
    expect(writes(link.onUnit(ctl('ENQ'), 0))).toEqual([ACK]);

    const a1 = link.onUnit(frameUnit(1, 'H|\\^&\r', false), 10);
    expect(writes(a1)).toEqual([]); // nothing ACKed yet
    expect(ofType(a1, 'frame')).toHaveLength(1);
    expect(link.currentState).toBe('awaiting-commit');
    expect(writes(link.commitFrame(true, 20))).toEqual([ACK]);

    link.onUnit(frameUnit(2, 'L|1|N\r'), 30);
    expect(writes(link.commitFrame(true, 40))).toEqual([ACK]);

    const done = ofType(link.onUnit(ctl('EOT'), 50), 'transfer-complete');
    expect(done[0]).toMatchObject({ complete: true, frameCount: 2 });
    expect(done[0]!.text.toString('latin1')).toBe('H|\\^&\rL|1|N\r');
    expect(link.currentState).toBe('idle');
  });

  it('NAKs when the frame could not be stored (no ACK for data we do not hold)', () => {
    const link = new AstmLink();
    link.onUnit(ctl('ENQ'), 0);
    link.onUnit(frameUnit(1, 'H|\\^&\r'), 1);
    expect(writes(link.commitFrame(false, 2))).toEqual([NAK]);
    // The instrument resends the same frame; it is offered again for storage.
    expect(ofType(link.onUnit(frameUnit(1, 'H|\\^&\r'), 3), 'frame')).toHaveLength(1);
  });

  it('NAKs a bad checksum and a wrong frame number', () => {
    const link = new AstmLink();
    link.onUnit(ctl('ENQ'), 0);
    const bad = { ...(frameUnit(1, 'x') as Extract<DecodedUnit, { type: 'frame' }>), checksumOk: false };
    expect(writes(link.onUnit(bad, 1))).toEqual([NAK]);
    expect(writes(link.onUnit(frameUnit(3, 'x'), 2))).toEqual([NAK]);
  });

  it('re-ACKs a retransmitted frame without appending it twice (lost ACK)', () => {
    const link = new AstmLink();
    link.onUnit(ctl('ENQ'), 0);
    link.onUnit(frameUnit(1, 'A'), 1);
    link.commitFrame(true, 2);
    const again = link.onUnit(frameUnit(1, 'A'), 3);
    expect(writes(again)).toEqual([ACK]);
    expect(ofType(again, 'frame')).toHaveLength(0);
    const [done] = ofType(link.onUnit(ctl('EOT'), 4), 'transfer-complete');
    expect(done!.text.toString()).toBe('A');
  });

  it('aborts a silent transfer after the receive timeout', () => {
    const link = new AstmLink();
    link.onUnit(ctl('ENQ'), 0);
    expect(link.nextDeadline()).toBe(E411_DEFAULT_TIMINGS.receiveTimeoutMs);
    expect(link.onTick(E411_DEFAULT_TIMINGS.receiveTimeoutMs - 1)).toEqual([]);
    expect(ofType(link.onTick(E411_DEFAULT_TIMINGS.receiveTimeoutMs), 'transfer-aborted')).toHaveLength(1);
    expect(link.currentState).toBe('idle');
  });

  it('ignores anything but ENQ while idle (D-5)', () => {
    const link = new AstmLink();
    expect(writes(link.onUnit(ctl('ACK'), 0))).toEqual([]);
    expect(writes(link.onUnit(frameUnit(1, 'x'), 0))).toEqual([]);
  });
});

describe('AstmLink as sender', () => {
  const body = Buffer.from(`H|\\^&\r${'O|1|x\r'.repeat(60)}L|1|N\r`, 'latin1');

  it('sends ENQ, frames on each ACK, then EOT', () => {
    const link = new AstmLink();
    link.enqueue({ id: 'm1', body });
    expect(writes(link.onTick(0))).toEqual([ENQ]);
    const expected = encodeMessageFrames(body, 'packed');
    const sent: Buffer[] = [];
    let a = link.onUnit(ctl('ACK'), 1);
    for (let i = 0; i < expected.length; i++) {
      sent.push(Buffer.from(writes(a)));
      a = link.onUnit(ctl('ACK'), 2 + i);
    }
    expect(Buffer.concat(sent).equals(Buffer.concat(expected))).toBe(true);
    expect(writes(a)).toEqual([EOT]);
    expect(ofType(a, 'sent')[0]?.id).toBe('m1');
  });

  it('retries after NAK to ENQ every 10 s and gives up after 6 retries', () => {
    const link = new AstmLink();
    link.enqueue({ id: 'm1', body });
    let t = 0;
    link.onTick(t);
    for (let i = 0; i < 6; i++) {
      link.onUnit(ctl('NAK'), t);
      t += E411_DEFAULT_TIMINGS.busyRetryDelayMs;
      expect(writes(link.onTick(t))).toEqual([ENQ]);
    }
    const last = link.onUnit(ctl('NAK'), t);
    expect(writes(last)).toEqual([EOT]);
    expect(ofType(last, 'send-failed')).toHaveLength(1);
  });

  it('yields to the instrument on contention and retries later (D-6)', () => {
    const link = new AstmLink();
    link.enqueue({ id: 'm1', body });
    link.onTick(0);
    expect(writes(link.onUnit(ctl('ENQ'), 5))).toEqual([ACK]);
    expect(link.currentState).toBe('receiving');
    link.onUnit(frameUnit(1, 'H|\\^&\rL|1|N\r'), 6);
    link.commitFrame(true, 7);
    link.onUnit(ctl('EOT'), 8);
    expect(link.currentState).toBe('idle');
    expect(writes(link.onTick(5 + E411_DEFAULT_TIMINGS.contentionBackoffMs))).toEqual([ENQ]);
  });

  it('resends a NAKed frame up to 6 times, then terminates', () => {
    const link = new AstmLink();
    link.enqueue({ id: 'm1', body: Buffer.from('H|\\^&\rL|1\r') });
    link.onTick(0);
    const first = writes(link.onUnit(ctl('ACK'), 1));
    for (let i = 0; i < 6; i++) expect(writes(link.onUnit(ctl('NAK'), 2 + i))).toEqual(first);
    const end = link.onUnit(ctl('NAK'), 9);
    expect(writes(end)).toEqual([EOT]);
    expect(ofType(end, 'send-failed')).toHaveLength(1);
  });

  it('terminates with EOT when the receiver does not answer within 15 s', () => {
    const link = new AstmLink();
    link.enqueue({ id: 'm1', body });
    link.onTick(0);
    const a = link.onTick(E411_DEFAULT_TIMINGS.replyTimeoutMs);
    expect(writes(a)).toEqual([EOT]);
    expect(ofType(a, 'send-failed')[0]?.reason).toMatch(/no reply to ENQ/);
  });
});

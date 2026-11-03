import { describe, expect, it } from 'vitest';
import {
  AstmDecoder,
  astmChecksum,
  encodeFrame,
  encodeMessageFrames,
  nextFrameNumber,
  splitIntoFrameTexts,
  type DecodedUnit,
} from '@lis/protocol-astm';

const bytes = (s: string) => Buffer.from(s, 'latin1');

describe('ASTM checksum', () => {
  it('matches the worked example in the e 411 manual (D-4): [STX]1Test[ETX] -> D4', () => {
    expect(astmChecksum(bytes('1Test\x03'))).toBe('D4');
    expect(encodeFrame(1, bytes('Test'), true).toString('latin1')).toBe('\x021Test\x03D4\r\n');
  });

  it('uses two uppercase hex digits with leading zero', () => {
    expect(astmChecksum(Uint8Array.from([0x01]))).toBe('01');
    expect(astmChecksum(Uint8Array.from([0xff, 0x02]))).toBe('01');
  });
});

describe('frame numbering and splitting', () => {
  it('wraps 7 -> 0', () => {
    expect([1, 2, 7].map(nextFrameNumber)).toEqual([2, 3, 0]);
  });

  it('splits long records into ETB middle frames and an ETX last frame (record-per-frame)', () => {
    const rec = `R|1|${'x'.repeat(300)}\r`;
    const parts = splitIntoFrameTexts(bytes(`H|\\^&\r${rec}L|1|N\r`), 'record-per-frame');
    expect(parts.map((p) => [p.text.length, p.final])).toEqual([
      [6, true],
      [240, false],
      [rec.length - 240, true],
      [6, true],
    ]);
  });

  it('packs records into 240-byte frames with only the last frame ETX (packed)', () => {
    const msg = bytes('A'.repeat(500));
    const parts = splitIntoFrameTexts(msg, 'packed');
    expect(parts.map((p) => [p.text.length, p.final])).toEqual([
      [240, false],
      [240, false],
      [20, true],
    ]);
  });

  it('rejects forbidden control bytes inside text', () => {
    expect(() => encodeFrame(1, bytes('a\x05b'), true)).toThrow(/forbidden/);
  });
});

describe('AstmDecoder', () => {
  const message = bytes(`H|\\^&|||cobas-e411^1|||||host|RSUPL^REAL|P|1\rP|1\rO|1|000004|40^0^5^^S1^SC|^^^10^|R||||||N||||1|||||||20051220095504|||F\r${'R|1|^^^10//not|1.25^|ulU/ml||N||F||admin|||E1\r'.repeat(5)}L|1|N\r`);
  const frames = encodeMessageFrames(message, 'packed');
  const wire = Buffer.concat([Buffer.from([0x05]), ...frames, Buffer.from([0x04])]);

  const decodeAll = (chunks: Buffer[]) => {
    const d = new AstmDecoder();
    return chunks.flatMap((c) => d.push(c));
  };
  const summary = (units: DecodedUnit[]) =>
    units.map((u) => (u.type === 'control' ? u.char : u.type === 'frame' ? `F${u.fn}${u.final ? 'x' : 'b'}${u.checksumOk ? '' : '!'}` : 'noise'));

  it('decodes a whole stream in one read', () => {
    expect(frames.length).toBeGreaterThan(1);
    const s = summary(decodeAll([wire]));
    expect(s[0]).toBe('ENQ');
    expect(s.at(-1)).toBe('EOT');
    expect(s.filter((x) => x.startsWith('F')).every((x) => !x.endsWith('!'))).toBe(true);
  });

  it('produces identical units for every possible split point (partial frames across reads)', () => {
    const expected = summary(decodeAll([wire]));
    for (let i = 1; i < wire.length; i++) {
      expect(summary(decodeAll([wire.subarray(0, i), wire.subarray(i)]))).toEqual(expected);
    }
  });

  it('handles one byte per read', () => {
    const chunks = [...wire].map((b) => Buffer.from([b]));
    const units = decodeAll(chunks);
    const text = Buffer.concat(units.flatMap((u) => (u.type === 'frame' ? [u.text] : [])));
    expect(text.equals(message)).toBe(true);
  });

  it('flags a corrupted checksum', () => {
    const f = Buffer.from(encodeFrame(1, bytes('Test'), true));
    f[7] = 0x30; // overwrite C1 (STX 1 T e s t ETX C1 C2 CR LF)
    const [u] = decodeAll([f]);
    expect(u).toMatchObject({ type: 'frame', checksumOk: false });
  });

  it('reports noise between frames and recovers', () => {
    const units = decodeAll([Buffer.concat([bytes('garbage'), encodeFrame(1, bytes('ok'), true)])]);
    expect(summary(units)).toEqual(['noise', 'F1x']);
  });

  it('abandons a partial frame when a control character interrupts it', () => {
    const f = encodeFrame(1, bytes('abcdef'), true);
    const units = decodeAll([f.subarray(0, 5), Buffer.from([0x04])]);
    expect(summary(units)).toEqual(['noise', 'EOT']);
  });

  it('bounds memory for an endless frame', () => {
    const d = new AstmDecoder({ maxFrameBytes: 300 });
    const units = d.push(Buffer.concat([Buffer.from([0x02]), Buffer.alloc(1000, 0x41)]));
    expect(units.some((u) => u.type === 'noise' && u.reason === 'frame exceeds size limit')).toBe(true);
    expect(d.bufferedBytes).toBeLessThan(300);
  });
});

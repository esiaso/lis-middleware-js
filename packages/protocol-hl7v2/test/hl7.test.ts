import { describe, expect, it } from 'vitest';
import { MllpDecoder, comp, encodeHl7, firstSegment, hl7Escape, hl7Timestamp, hl7Unescape, mllpWrap, parseHl7, repetitions, DEFAULT_HL7_DELIMITERS, Hl7ParseError } from '@lis/protocol-hl7v2';

const msgA = 'MSH|^~\\&|||||20261103101500||ORU^R01|7|P|2.3.1||||||UNICODE\rOBR|1||S1\r';
const msgB = 'MSH|^~\\&|||||20261103101501||ORU^R01|8|Q|2.3.1||||||UNICODE\rOBR|1||QC1\r';

describe('MllpDecoder', () => {
  const wire = Buffer.concat([mllpWrap(Buffer.from(msgA)), mllpWrap(Buffer.from(msgB))]);
  const payloads = (units: ReturnType<MllpDecoder['push']>) => units.flatMap((u) => (u.type === 'message' ? [u.payload.toString()] : []));

  it('extracts two blocks from one read', () => {
    expect(payloads(new MllpDecoder().push(wire))).toEqual([msgA, msgB]);
  });

  it('gives identical output for every split point', () => {
    for (let i = 1; i < wire.length; i++) {
      const d = new MllpDecoder();
      expect([...payloads(d.push(wire.subarray(0, i))), ...payloads(d.push(wire.subarray(i)))]).toEqual([msgA, msgB]);
    }
  });

  it('reports noise, a restarted block, and an oversized block while staying bounded', () => {
    const d = new MllpDecoder(50);
    const units = d.push(Buffer.concat([Buffer.from('junk'), Buffer.from([0x0b]), Buffer.from('partial'), mllpWrap(Buffer.alloc(200, 0x41)), mllpWrap(Buffer.from('MSH|ok'))]));
    expect(units.map((u) => u.type)).toEqual(['noise', 'noise', 'overflow', 'message']);
    expect(d.bufferedBytes).toBe(0);
  });

  it('tolerates a missing CR after the end block', () => {
    const d = new MllpDecoder();
    const units = d.push(Buffer.concat([Buffer.from([0x0b]), Buffer.from('MSH|a'), Buffer.from([0x1c]), Buffer.from([0x0b]), Buffer.from('MSH|b'), Buffer.from([0x1c, 0x0d])]));
    expect(payloads(units)).toEqual(['MSH|a', 'MSH|b']);
  });
});

describe('HL7 parsing', () => {
  it('numbers MSH fields as the standard does', () => {
    const m = parseHl7(msgA);
    const msh = firstSegment(m, 'MSH');
    expect(comp(m, msh, 9, 1)).toBe('ORU');
    expect(comp(m, msh, 10)).toBe('7');
    expect(comp(m, msh, 18)).toBe('UNICODE');
    expect(comp(m, firstSegment(m, 'OBR'), 3)).toBe('S1');
  });

  it('splits repetitions such as OBX-8 "H~A"', () => {
    const m = parseHl7('MSH|^~\\&|||||||ORU^R01|1|P|2.3.1\rOBX|1|NM|6690-2^WBC^LN||12.1|10*9/L|4.00-10.00|H~A|||F\r');
    expect(repetitions(m, firstSegment(m, 'OBX'), 8)).toEqual(['H', 'A']);
  });

  it('round-trips escapes including \\.br\\', () => {
    const s = 'a|b^c~d\\e&f\rg';
    expect(hl7Unescape(hl7Escape(s), DEFAULT_HL7_DELIMITERS)).toBe(s);
  });

  it('rejects non-HL7 input with an MSA-6 style status code', () => {
    expect(() => parseHl7('hello')).toThrow(Hl7ParseError);
    try {
      parseHl7('PID|1');
    } catch (e) {
      expect((e as Hl7ParseError).statusCode).toBe(100);
    }
  });

  it('encodes MSH with MSH-1 implied', () => {
    expect(encodeHl7([['MSH', '^~\\&', 'LIS'], ['MSA', 'AA', '2']])).toBe('MSH|^~\\&|LIS\rMSA|AA|2\r');
  });

  it('renders timestamps in the configured zone', () => {
    expect(hl7Timestamp(new Date('2026-11-03T07:15:30Z'), 'Africa/Nairobi')).toBe('20261103101530');
  });
});

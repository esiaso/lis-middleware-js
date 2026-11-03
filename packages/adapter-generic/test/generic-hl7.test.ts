import { describe, expect, it } from 'vitest';
import { GenericHl7Profile } from '@lis/contracts';
import { buildGenericAck, parseGenericHl7Payload } from '@lis/adapter-generic';
import { parseHl7 } from '@lis/protocol-hl7v2';

// Synthetic ORU^R01. Not taken from any instrument manual.
const ctx = { rawMessageId: '1f0e4f0c-5c43-4e0c-9a0b-2d6c1a3e9b77', instrumentId: 'coag-01', receivedAt: '2026-11-03T10:00:00+03:00' };
const oru = [
  'MSH|^~\\&|COAG|LAB|||20261103100000||ORU^R01|MSG0001|P|2.5||||||UNICODE UTF-8',
  'PID|1||PAT-1',
  'OBR|1|L26110300050||PT^Prothrombin',
  'OBX|1|NM|PT^Prothrombin time^L||12.8|s|10.0-13.5|N|||F|||20261103095900',
  'OBX|2|NM|INR^INR^L||1.05||||||F',
  'OBX|3|ED|CURVE^Clot curve||^AP^^Base64^AAAA||||||F',
  'OBX|4|ST|COMMENT||Lipaemic µ sample||||||P',
  'OBR|2|QC-LOT-77||APTT',
  'OBX|1|NM|APTT^APTT||31.2|s|||||F',
].join('\r');

describe('generic HL7 profile', () => {
  const profile = GenericHl7Profile.parse({
    profile: 'generic-hl7-mllp',
    sampleId: { segment: 'OBR', field: 2 },
    testCodeSystem: { segment: 'OBX', field: 3, component: 3 },
    qcRule: { at: { segment: 'OBR', field: 2 }, equals: ['QC-LOT-77'] },
  });

  it('makes one message per OBR group with OBX values, skipping binary items', () => {
    const r = parseGenericHl7Payload(Buffer.from(oru, 'utf8'), profile, ctx);
    expect(r.kind).toBe('result');
    if (r.kind !== 'result') return;
    expect(r.messages).toHaveLength(2);
    const [pat, qc] = r.messages;
    expect(pat).toMatchObject({ sampleId: 'L26110300050', sampleClass: 'patient', instrumentContext: { binaryItems: '1', messageControlId: 'MSG0001' } });
    expect(pat?.observations.map((o) => o.instrumentTestCode)).toEqual(['PT', 'INR', 'COMMENT']);
    expect(pat?.observations[0]).toMatchObject({ instrumentCodeSystem: 'L', value: { kind: 'numeric', value: '12.8', scale: 1 }, units: 's', abnormalFlags: ['N'], resultStatus: 'final' });
    expect(pat?.observations[2]).toMatchObject({ value: { kind: 'text', text: 'Lipaemic µ sample' }, resultStatus: 'unknown' });
    expect(qc).toMatchObject({ sampleClass: 'qc', sampleId: 'QC-LOT-77' });
  });

  it('warns when the profile has no QC rule', () => {
    const p = GenericHl7Profile.parse({ profile: 'generic-hl7-mllp', sampleId: { segment: 'OBR', field: 2 } });
    const r = parseGenericHl7Payload(Buffer.from(oru, 'utf8'), p, ctx);
    if (r.kind !== 'result') throw new Error('expected result');
    expect(r.messages[0]?.warnings.map((w) => w.code)).toContain('NO_QC_RULE');
  });

  it('stores but does not act on other message types', () => {
    const qry = 'MSH|^~\\&|COAG|LAB|||20261103100000||QRY^Q02|Q1|P|2.3.1\rQRD|x';
    expect(parseGenericHl7Payload(Buffer.from(qry, 'utf8'), profile, ctx).kind).toBe('unsupported');
  });

  it('rejects invalid UTF-8 so the raw bytes are quarantined', () => {
    const bad = Buffer.concat([Buffer.from(oru.slice(0, 40), 'utf8'), Buffer.from([0xff, 0xfe])]);
    expect(() => parseGenericHl7Payload(bad, profile, ctx)).toThrow();
  });

  it('builds an original-mode ACK echoing control ID, processing ID and version', () => {
    const r = parseGenericHl7Payload(Buffer.from(oru, 'utf8'), profile, ctx);
    const ack = parseHl7(buildGenericAck(r.header, profile, 'A1', new Date('2026-11-03T07:00:00Z'), 'Africa/Nairobi').toString('utf8'));
    const msh = ack.segments[0]?.fields ?? [];
    expect(msh[5]).toBe('COAG');
    expect(msh[7]).toBe('20261103100000');
    expect(msh[9]).toBe('ACK^R01');
    expect(msh[11]).toBe('P');
    expect(msh[12]).toBe('2.5');
    expect(ack.segments[1]?.fields).toEqual(['MSA', 'AA', 'MSG0001']);
  });
});

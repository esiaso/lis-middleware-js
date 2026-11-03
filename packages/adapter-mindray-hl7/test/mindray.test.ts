import { describe, expect, it } from 'vitest';
import { NormalizedAnalyzerMessage } from '@lis/contracts';
import { MindrayOptions, buildAck, buildWorklistReply, parseMindrayPayload } from '@lis/adapter-mindray-hl7';

// Synthetic fixtures shaped like the examples in the Mindray HL7 document (sections 5.1-5.5).
const ctx = { rawMessageId: '0190f6a2-7c1e-7d8a-9b3c-123456789abc', instrumentId: 'mindray-01', receivedAt: '2026-11-03T10:00:00Z' };
const opts = MindrayOptions.parse({ timeZone: 'Africa/Nairobi' });
const now = new Date('2026-11-03T07:15:30Z');
const seg = (...s: string[]) => Buffer.from(s.map((x) => `${x}\r`).join(''), 'utf8');

const oru = seg(
  'MSH|^~\\&|||||20261103101500||ORU^R01|2|P|2.3.1||||||UNICODE',
  'PID|1||CHART001^^^^MR||Doe^Jane||19800131000000|Female',
  'PV1|1||OPD^^Bed1',
  'OBR|1||L26110300043|00001^Automated Count^99MRC||20261103090000|20261103101400|||op1||||20261103090500||||||||||HM||||||||tech1',
  'OBX|1|IS|08002^Blood Mode^99MRC||W||||||F',
  'OBX|2|IS|08003^Test Mode^99MRC||CBC+5DIFF||||||F',
  'OBX|3|NM|6690-2^WBC^LN||12.10|10*9/L|4.00-10.00|H~A|||F',
  'OBX|4|NM|718-7^HGB^LN||135|g/L|110-150|N|||F||E',
  'OBX|5|NM|777-3^PLT^LN||***|10*9/L|100-300|N|||F',
  'OBX|6|IS|01006^Recheck flag^99MRC||T||||||F',
  'OBX|7|ED|15000^WBC Histogram. Binary^99MRC||^Application^Octet-stream^Base64^AAAA||||||F',
);

describe('ORU^R01', () => {
  it('normalises a sample result', () => {
    const r = parseMindrayPayload(oru, ctx);
    expect(r.kind).toBe('result');
    if (r.kind !== 'result') return;
    const m = r.message;
    expect(NormalizedAnalyzerMessage.safeParse(m).success).toBe(true);
    expect(m).toMatchObject({ sampleId: 'L26110300043', sampleClass: 'patient', instrumentContext: { instrumentPatientId: 'CHART001', binaryItems: '1' } });
    const byCode = Object.fromEntries(m.observations.map((o) => [o.instrumentTestCode, o]));
    expect(byCode['6690-2']).toMatchObject({ instrumentCodeSystem: 'LN', value: { kind: 'numeric', value: '12.10', scale: 2 }, abnormalFlags: ['H', 'A'], units: '10*9/L', referenceRangeText: '4.00-10.00', resultStatus: 'rerun' });
    expect(byCode['718-7']).toMatchObject({ editedOnInstrument: true, instrumentFlags: [{ code: 'OBX13_E' }] });
    expect(byCode['777-3']?.value).toEqual({ kind: 'absent', reason: 'masked' });
    expect(byCode['08003']?.value).toEqual({ kind: 'qualitative', code: 'CBC+5DIFF' });
    expect(byCode['15000']).toBeUndefined(); // ED blobs are not observations
  });

  it('classifies QC by MSH-11 = Q and takes the lot from PID-3', () => {
    const qc = seg('MSH|^~\\&|||||20261103101500||ORU^R01|3|Q|2.3.1||||||UNICODE', 'PID|1||LOT42^^^^MR', 'OBR|1||QCFILE1|00003^LJ QCR^99MRC', 'OBX|1|IS|05001^Qc Level^99MRC||M||||||F', 'OBX|2|NM|6690-2^WBC^LN||7.10|10*9/L||||F');
    const r = parseMindrayPayload(qc, ctx);
    expect(r.kind === 'result' && r.message).toMatchObject({ sampleClass: 'qc', qc: { lot: 'LOT42', level: 'M' }, instrumentContext: { instrumentPatientId: '' } });
  });

  it('rejects invalid UTF-8 so the raw bytes can be quarantined', () => {
    const bad = Buffer.concat([seg('MSH|^~\\&|||||x||ORU^R01|1|P|2.3.1'), Buffer.from([0xff, 0xfe])]);
    expect(() => parseMindrayPayload(bad, ctx)).toThrow();
  });

  it('builds ACK^R01 echoing MSH-10 and MSH-11 (5.2, 5.4)', () => {
    const r = parseMindrayPayload(oru, ctx);
    expect(buildAck(r.header, '1', opts, now).toString()).toBe('MSH|^~\\&|LIS||||20261103101530||ACK^R01|1|P|2.3.1||||||UNICODE\rMSA|AA|2\r');
    expect(buildAck({ ...r.header, processingId: 'Q' }, '9', opts, now, 'AE', { statusCode: 101, text: 'Required field missing' }).toString()).toContain('MSA|AE|2|Required field missing|||101\r');
  });
});

describe('ORM^O01 worklist query', () => {
  const orm = seg('MSH|^~\\&|||||20261103101500||ORM^O01|60|P|2.3.1||||||UNICODE', 'ORC|RF||L26110300043||IP');

  it('extracts the sample ID from ORC-3', () => {
    const r = parseMindrayPayload(orm, ctx);
    expect(r.kind === 'worklist-query' && r.sampleIds).toEqual(['L26110300043']);
  });

  it('replies ORR^O02 with ORC-2 and OBR-2 equal to the sample ID (5.5)', () => {
    const r = parseMindrayPayload(orm, ctx);
    const reply = buildWorklistReply(r.header, '61', { found: true, sampleId: 'L26110300043', patient: { id: 'CHART001', familyName: 'Doe', givenName: 'Jane', birthDate: '19800131000000', sex: 'Female' }, location: { pointOfCare: 'OPD', bed: 'Bed1' }, testMode: 'CBC+5DIFF', ageYears: '46' }, opts, now).toString();
    const lines = reply.split('\r');
    expect(lines[0]).toBe('MSH|^~\\&|LIS||||20261103101530||ORR^O02|61|P|2.3.1||||||UNICODE');
    expect(lines.slice(1, 8)).toEqual([
      'MSA|AA|60',
      'PID|1||CHART001^^^^MR||Doe^Jane||19800131000000|Female',
      'PV1|1||OPD^^Bed1',
      'ORC|AF|L26110300043',
      'OBR|1|L26110300043||00001^Automated Count^99MRC',
      'OBX|1|IS|08003^Test Mode^99MRC||CBC+5DIFF||||||F',
      'OBX|2|NM|30525-0^Age^LN||46|yr|||||F',
    ]);
    const none = buildWorklistReply(r.header, '62', { found: false, sampleId: 'X' }, opts, now).toString();
    expect(none.split('\r').filter(Boolean)).toHaveLength(2);
  });
});

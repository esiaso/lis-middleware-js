import { describe, expect, it } from 'vitest';
import { GenericAstmProfile } from '@lis/contracts';
import { parseGenericAstmTransfer } from '@lis/adapter-generic';

// Synthetic transfer in plain E1394 layout. Not taken from any instrument manual.
const ctx = { rawMessageId: '7d9c1f40-1b7a-4c55-8a51-0b2f7f6a2b10', instrumentId: 'chem-02', receivedAt: '2026-11-03T10:00:00+03:00' };
const transfer = [
  'H|\\^&|||ACME^1.2|||||||P|1',
  'P|1',
  'O|1|L26110300042||^^^GLU|R||||||N',
  'R|1|^^^GLU|5.40|mmol/L|3.9-6.1|N||F||||20261103095500',
  'R|2|^^^CREA|>1500|umol/L||H\\A||F', // repeat delimiter from H-2 is "\\"
  'C|1||Sample hemolysed|G',
  'R|3|^^^K|***.*|mmol/L||||X',
  'O|2|CTRL-N1||^^^GLU|R||||||Q',
  'R|1|^^^GLU|5.10|mmol/L||||F',
  'L|1|N',
].join('\r') + '\r';

describe('generic ASTM profile', () => {
  const profile = GenericAstmProfile.parse({ profile: 'generic-astm', sampleId: { record: 'O', field: 3 } });

  it('splits by order record and reads the standard E1394 result positions', () => {
    const r = parseGenericAstmTransfer(Buffer.from(transfer, 'latin1'), profile, ctx);
    expect(r.errors).toEqual([]);
    expect(r.results).toHaveLength(2);
    const [patient, qc] = r.results;
    expect(patient?.sampleId).toBe('L26110300042');
    expect(patient?.sampleClass).toBe('patient');
    expect(patient?.adapter.name).toBe('generic-astm');
    expect(patient?.instrumentContext['driver']).toBe('generic');
    const [glu, crea, k] = patient?.observations ?? [];
    expect(glu).toMatchObject({ instrumentTestCode: 'GLU', value: { kind: 'numeric', value: '5.40', scale: 2 }, units: 'mmol/L', referenceRangeText: '3.9-6.1', abnormalFlags: ['N'], resultStatus: 'final', completedAtText: '20261103095500' });
    expect(crea).toMatchObject({ value: { kind: 'censored', comparator: '>', limit: '1500' }, abnormalFlags: ['H', 'A'] });
    expect(crea?.instrumentFlags).toEqual([{ code: 'COMMENT', text: 'Sample hemolysed' }]);
    // Unmapped status code stays "unknown" rather than being guessed.
    expect(k).toMatchObject({ value: { kind: 'absent', reason: 'masked' }, resultStatus: 'unknown' });
    expect(qc).toMatchObject({ sampleClass: 'qc', qc: { controlName: 'CTRL-N1' }, sampleIdReadError: false });
  });

  it('reads the sample ID where the profile says (e.g. O-4 component 1)', () => {
    const p = GenericAstmProfile.parse({ profile: 'generic-astm', sampleId: { record: 'O', field: 4, component: 1 } });
    const t = 'H|\\^&\rO|1||S-77^^12|^^^NA\rR|1|^^^NA|140|mmol/L||||F\rL|1\r';
    const r = parseGenericAstmTransfer(Buffer.from(t, 'latin1'), p, ctx);
    expect(r.results[0]?.sampleId).toBe('S-77');
  });

  it('flags a missing sample ID and counts host queries it will not answer', () => {
    const t = 'H|\\^&\rQ|1|^SID1||ALL\rO|1||||\rR|1|^^^NA|140\rL|1\r';
    const r = parseGenericAstmTransfer(Buffer.from(t, 'latin1'), profile, ctx);
    expect(r.unsupportedQueries).toBe(1);
    expect(r.results[0]?.sampleIdReadError).toBe(true);
  });

  it('applies the administrator status map', () => {
    const p = GenericAstmProfile.parse({ profile: 'generic-astm', sampleId: { record: 'O', field: 3 }, resultStatusMap: { F: 'final', C: 'rerun' } });
    const t = 'H|\\^&\rO|1|S1\rR|1|^^^NA|141|||||C\rL|1\r';
    expect(parseGenericAstmTransfer(Buffer.from(t, 'latin1'), p, ctx).results[0]?.observations[0]?.resultStatus).toBe('rerun');
  });

  it('rejects a profile without a sample ID location or with QC decided on a result record', () => {
    expect(GenericAstmProfile.safeParse({ profile: 'generic-astm' }).success).toBe(false);
    expect(
      GenericAstmProfile.safeParse({ profile: 'generic-astm', sampleId: { record: 'O', field: 3 }, qcRule: { at: { record: 'R', field: 9 }, equals: ['Q'] } }).success,
    ).toBe(false);
  });
});

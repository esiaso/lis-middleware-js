import { describe, expect, it } from 'vitest';
import { NormalizedAnalyzerMessage } from '@lis/contracts';
import { E411Options, E411ReplyError, buildE411QueryReply, parseE411Transfer } from '@lis/adapter-cobas-e411';

// Fixtures are synthetic, laid out like the communication traces in the
// e 411 Host Interface Manual v2.2, chapter F. No patient data.
const ctx = { rawMessageId: '0190f6a2-7c1e-7d8a-9b3c-123456789abc', instrumentId: 'e411-01', receivedAt: '2026-11-03T10:16:04Z' };
const cobas = E411Options.parse({ protocolType: 'cobas', qualitativeTestCodes: ['400'] });
const elecsys = E411Options.parse({ protocolType: 'elecsys', qualitativeTestCodes: ['400'] });
const t = (...records: string[]) => Buffer.from(records.map((r) => `${r}\r`).join(''), 'latin1');

describe('cobas® type', () => {
  it('parses a real-time order inquiry (F-3)', () => {
    const r = parseE411Transfer(t('H|\\^&|||cobas-e411^1|||||host|TSREQ^REAL|P|1', 'Q|1|^^000004^40^0^5^^S1^SC||ALL||||||||O', 'L|1|N'), cobas, ctx);
    expect(r.errors).toEqual([]);
    expect(r.queries).toEqual([
      {
        kind: 'order-query',
        sampleId: '000004',
        sampleIdReadError: false,
        location: { sequenceNo: '40', carrierNo: '0', positionNo: '5', sampleType: 'S1', containerType: 'SC' },
        meaning: 'TSREQ^REAL',
      },
    ]);
  });

  it('recognises a cancel and a generated read-error ID "@<seq>" (E-9, F-3, F-5)', () => {
    const cancel = parseE411Transfer(t('H|\\^&|||cobas-e411^1|||||host|TSREQ^REAL|P|1', 'Q|1|^^000004^40^0^5^^S1^SC||ALL||||||||A', 'L|1|N'), cobas, ctx);
    expect(cancel.queries[0]?.kind).toBe('query-cancel');
    const readErr = parseE411Transfer(t('H|\\^&|||cobas-e411^1|||||host|TSREQ^REAL|P|1', 'Q|1|^^@3^3^0007^2^^S1^SC||ALL||||||||O', 'L|1|N'), cobas, ctx);
    expect(readErr.queries[0]).toMatchObject({ sampleId: '@3', sampleIdReadError: true });
  });

  it('builds the reply exactly as in the manual trace, echoing seq/carrier/position (F-3)', () => {
    const q = parseE411Transfer(t('H|\\^&|||cobas-e411^1|||||host|TSREQ^REAL|P|1', 'Q|1|^^000004^40^0^5^^S1^SC||ALL||||||||O', 'L|1|N'), cobas, ctx).queries[0]!;
    const reply = buildE411QueryReply(q, { found: true, priority: 'routine', tests: [{ hostTestCode: '10' }, { hostTestCode: '30', dilutionRatio: 2 }, { hostTestCode: '40' }] }, cobas);
    expect(reply.toString('latin1').split('\r')).toEqual([
      'H|\\^&|||host^1|||||cobas-e411|TSDWN^REPLY|P|1',
      'P|1',
      'O|1|000004|40^0^5^^S1^SC|^^^10^\\^^^30^2\\^^^40^|R||||||A||||1||||||||||O',
      'L|1|N',
      '',
    ]);
    const none = buildE411QueryReply(q, { found: false, priority: 'routine', tests: [] }, cobas);
    expect(none.toString('latin1').split('\r')[2]).toBe('O|1|000004|40^0^5^^S1^SC||R||||||A||||1||||||||||O');
  });

  it('refuses duplicate tests and more than 18 tests (E-12, E-13)', () => {
    const q = parseE411Transfer(t('H|\\^&', 'Q|1|^^1^1^0^1^^S1^SC||ALL||||||||O', 'L|1|N'), cobas, ctx).queries[0]!;
    expect(() => buildE411QueryReply(q, { found: true, priority: 'stat', tests: [{ hostTestCode: '10' }, { hostTestCode: '10' }] }, cobas)).toThrow(E411ReplyError);
    const many = Array.from({ length: 19 }, (_, i) => ({ hostTestCode: String(100 + i) }));
    expect(() => buildE411QueryReply(q, { found: true, priority: 'stat', tests: many }, cobas)).toThrow(/18/);
  });

  it('parses results: quantitative, rerun with dilution, qualitative with COI, alarm comment (F-6 to F-8)', () => {
    const r = parseE411Transfer(
      t(
        'H|\\^&|||cobas-e411^1|||||host|RSUPL^REAL|P|1',
        'P|1',
        'O|1|000002|3^0007^2^^S1^SC|^^^10^|R||||||N||||1|||||||20051220104418|||F',
        'R|1|^^^10//not|0.163|ulU/ml||L||F||admin|||E1',
        'C|1|I|48|I',
        'R|2|^^^30/2/pre-diluted|>100.0^|ng/dl||HH||C||admin|||E1',
        'R|3|^^^400//not|-1^0.303|COI||N||F||admin|||E1',
        'R|4|^^^40//not|       ^|ng/ml||||F||admin|||E1',
        'L|1|N',
      ),
      cobas,
      ctx,
    );
    expect(r.errors).toEqual([]);
    const m = r.results[0]!;
    expect(NormalizedAnalyzerMessage.safeParse(m).success).toBe(true);
    expect(m).toMatchObject({ sampleId: '000002', sampleClass: 'patient', sampleIdReadError: false });
    const [tsh, ft4, hiv, absent] = m.observations;
    expect(tsh).toMatchObject({ instrumentTestCode: '10', value: { kind: 'numeric', value: '0.163', scale: 3 }, abnormalFlags: ['L'], resultStatus: 'initial', instrumentFlags: [{ code: 'ALARM48' }] });
    expect(ft4).toMatchObject({ value: { kind: 'censored', comparator: '>', limit: '100.0' }, dilution: '2', preDiluted: true, resultStatus: 'rerun', abnormalFlags: ['HH'] });
    expect(hiv).toMatchObject({ value: { kind: 'qualitative', code: '-1' }, secondaryValue: { kind: 'numeric', value: '0.303' }, units: 'COI' });
    expect(absent?.value).toEqual({ kind: 'absent', reason: 'no-result' });
    expect(absent?.originalValueText).toBe('       ^');
  });

  it('classifies control results as QC, never as patient (C-2, F-8)', () => {
    const r = parseE411Transfer(
      t('H|\\^&|||cobas-e411^1|||||host|RSUPL^REAL|P|1', 'P|1', 'O|1|PCU2^LOT123|96^0019^1^^QC^SC|^^^400^||||||Q||||1|||||||20051220104418|||F', 'R|1|^^^400//not|1.26^|ulU/ml||L||F||admin|||E1', 'L|1|N'),
      cobas,
      ctx,
    );
    expect(r.results[0]).toMatchObject({ sampleClass: 'qc', qc: { controlName: 'PCU2', lot: 'LOT123' }, sampleIdReadError: false });
  });
});

describe('Elecsys® type', () => {
  it('parses a query and builds a reply with factor-coded dilution and report type Q / Z (F-2)', () => {
    const r = parseE411Transfer(t('H|\\^&||||||||||P||', 'Q|1|^000004^40^0^5^^SAMPLE^NORMAL||ALL||||||||O', 'L|1|I'), elecsys, ctx);
    const q = r.queries[0]!;
    expect(q).toMatchObject({ sampleId: '000004', location: { sequenceNo: '40', sampleType: 'SAMPLE', containerType: 'NORMAL' } });
    const reply = buildE411QueryReply(q, { found: true, priority: 'routine', tests: [{ hostTestCode: '10' }, { hostTestCode: '30', dilutionRatio: 5 }, { hostTestCode: '40' }] }, elecsys);
    expect(reply.toString('latin1').split('\r')[2]).toBe('O|1|000004|40^0^5^^SAMPLE^NORMAL|^^^10^\\^^^30^2\\^^^40^|R||||||N||||||||||||||Q');
    const none = buildE411QueryReply(q, { found: false, priority: 'routine', tests: [] }, elecsys);
    expect(none.toString('latin1').split('\r')[2]).toBe('O|1|000004|40^0^5^^SAMPLE^NORMAL||R||||||N||||||||||||||Z');
  });

  it('parses results with reference range, completion time and alarm text (F-7)', () => {
    const r = parseE411Transfer(
      t(
        'H|\\^&||||||||||P||',
        'P|1||||||||||||||||||||||||||||||||||',
        'O|1|000002|3^0007^2^^SAMPLE^NORMAL|ALL|R|20051220104418|||||X||||||||||||||O',
        'R|1|^^^10^^0|0.163|ulU/ml|0.270^4.20|L||F|||20051220103034|20051220105004|',
        'C|1|I|48^Below normal(expected) range|I',
        'L|1|',
      ),
      elecsys,
      ctx,
    );
    const o = r.results[0]!.observations[0]!;
    expect(o).toMatchObject({
      instrumentTestCode: '10',
      referenceRangeText: '0.270-4.20',
      completedAtText: '20051220105004',
      resultStatus: 'final',
      instrumentFlags: [{ code: 'ALARM48', text: 'Below normal(expected) range' }],
      preDiluted: false,
    });
  });

  it('treats "X\\Q" action code and CONTROL sample type as QC (E-12, F-8)', () => {
    const r = parseE411Transfer(
      t('H|\\^&||||||||||P||', 'O|1|PCU2|96^0019^1^^CONTROL^NORMAL|ALL|R|20051220104418|||||X\\Q||||||||||||||O', 'R|1|^^^10^^0|1.45|ulU/ml|1.37^1.97|N||F|||x|y|', 'L|1|'),
      elecsys,
      ctx,
    );
    expect(r.results[0]?.sampleClass).toBe('qc');
  });
});

import { describe, expect, it } from 'vitest';
import { evaluateQc, parseQcRange, qcSupports, type QcRange } from '../src/index.js';

// Range values here are made up for the tests. They are not from any control insert.
const R = (over: Partial<QcRange> = {}): QcRange => ({ id: 'q1', controlLot: 'L123', controlName: null, low: '4.1', high: '4.9', units: 'mmol/L', ...over });
const num = (value: string) => ({ kind: 'numeric' as const, value, scale: value.split('.')[1]?.length ?? 0 });

describe('evaluateQc', () => {
  it('checks the value against the range, both ends included', () => {
    expect(evaluateQc(num('4.1'), 'mmol/L', [R()], { lot: 'L123' })).toMatchObject({ outcome: 'IN_RANGE', rangeId: 'q1' });
    expect(evaluateQc(num('4.9'), 'mmol/L', [R()], { lot: 'L123' }).outcome).toBe('IN_RANGE');
    expect(evaluateQc(num('5.0'), 'mmol/L', [R()], { lot: 'L123' })).toMatchObject({ outcome: 'OUT_OF_RANGE', detail: '5.0 outside 4.1 to 4.9 mmol/L' });
  });

  it('uses the most specific range for the control, and says when there is none', () => {
    const both = R({ id: 'both', controlName: 'PreciControl 1', low: '1', high: '2' });
    expect(evaluateQc(num('1.5'), 'mmol/L', [R(), both], { lot: 'L123', controlName: 'PreciControl 1' })).toMatchObject({ outcome: 'IN_RANGE', rangeId: 'both' });
    expect(evaluateQc(num('4.5'), 'mmol/L', [R(), both], { lot: 'L123', controlName: 'Other' }).rangeId).toBe('q1');
    expect(evaluateQc(num('4.5'), 'mmol/L', [R()], { lot: 'L999', controlName: 'PC' })).toMatchObject({ outcome: 'NO_RANGE', detail: 'no range for PC, lot L999' });
    expect(evaluateQc(num('4.5'), 'mmol/L', [R()], {})).toMatchObject({ outcome: 'NO_RANGE', detail: 'no range for unnamed control' });
  });

  it('never compares across units or with non-numbers', () => {
    expect(evaluateQc(num('4.5'), 'mg/dL', [R()], { lot: 'L123' }).outcome).toBe('UNITS_DIFFER');
    expect(evaluateQc({ kind: 'qualitative', code: 'POS' }, 'mmol/L', [R()], { lot: 'L123' }).outcome).toBe('NOT_NUMERIC');
  });
});

describe('qcSupports', () => {
  const at = (m: number) => new Date(Date.UTC(2026, 10, 4, 8, m));
  it('needs a checked control, and the latest for each control in range', () => {
    expect(qcSupports([], 8)).toEqual({ ok: false, detail: 'no checked QC result in the last 8 h' });
    expect(qcSupports([{ rangeId: null, outcome: 'NO_RANGE', at: at(0) }], 8).ok).toBe(false);
    expect(qcSupports([{ rangeId: 'a', outcome: 'IN_RANGE', at: at(0) }, { rangeId: 'b', outcome: 'IN_RANGE', at: at(1) }], 8)).toEqual({ ok: true, detail: '2 controls in range in the last 8 h' });
    // Out of range, then rerun in range: fine. In range, then out: not.
    expect(qcSupports([{ rangeId: 'a', outcome: 'OUT_OF_RANGE', at: at(0) }, { rangeId: 'a', outcome: 'IN_RANGE', at: at(5) }], 8).ok).toBe(true);
    expect(qcSupports([{ rangeId: 'a', outcome: 'IN_RANGE', at: at(5) }, { rangeId: 'a', outcome: 'UNITS_DIFFER', at: at(9) }, { rangeId: 'b', outcome: 'IN_RANGE', at: at(9) }], 8)).toEqual({ ok: false, detail: '1 of 2 controls failed the latest QC' });
  });
});

describe('parseQcRange', () => {
  const base = { instrumentId: 'c111-01', localTestCode: 'K', controlLot: 'L123', controlName: '', low: '4.1', high: '4.9', units: 'mmol/L', reference: 'Control insert L123 rev 2' };
  it('accepts a range', () => {
    expect(parseQcRange(base)).toEqual({ ok: true, value: { ...base, controlName: null, targetMean: null, targetSd: null, westgardRules: [] } });
  });
  it('explains every problem', () => {
    const r = parseQcRange({ instrumentId: '', localTestCode: '', controlLot: '', controlName: '', low: 'x', high: '1', units: '', reference: '' });
    expect(!r.ok && r.issues.length).toBe(6);
    expect(parseQcRange({ ...base, low: '5' }).ok).toBe(false);
  });
});

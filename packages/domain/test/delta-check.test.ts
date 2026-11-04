import { describe, expect, it } from 'vitest';
import { absDifference, evaluateDelta, parseDeltaRule, type DeltaRule } from '../src/index.js';

// Rule values here are made up for the tests. They are not clinical guidance.
const R = (over: Partial<DeltaRule> = {}): DeltaRule => ({ id: 'd1', maxAbs: '1.0', maxPercent: null, windowDays: 7, units: 'mmol/L', ...over });
const num = (value: string) => ({ kind: 'numeric' as const, value, scale: value.split('.')[1]?.length ?? 0 });
const prev = (value: string, units: string | null = 'mmol/L') => ({ resultId: 'p1', value: num(value), units, collectedAt: new Date() });

describe('absDifference', () => {
  it('is exact at any scale and sign', () => {
    expect(absDifference('4.2', '3.15')).toBe('1.05');
    expect(absDifference('0.1', '0.3')).toBe('0.2');
    expect(absDifference('-1', '2.5')).toBe('3.5');
    expect(absDifference('10', '10.00')).toBe('0.00');
    expect(absDifference('0.003', '0.001')).toBe('0.002');
  });
});

describe('evaluateDelta', () => {
  it('flags a change strictly over the absolute limit', () => {
    expect(evaluateDelta(num('5.0'), 'mmol/L', R(), prev('4.0'))).toBeNull();
    expect(evaluateDelta(num('5.01'), 'mmol/L', R(), prev('4.0'))).toMatchObject({ flag: 'EXCEEDED', previousResultId: 'p1', detail: 'changed by 1.01 mmol/L from 4.0 (more than 1.0 mmol/L)' });
    expect(evaluateDelta(num('2.9'), 'mmol/L', R(), prev('4.0'))?.flag).toBe('EXCEEDED');
  });

  it('flags a change strictly over the percentage, relative to the previous value', () => {
    const r = R({ maxAbs: null, maxPercent: '25' });
    expect(evaluateDelta(num('125'), 'mmol/L', r, prev('100'))).toBeNull();
    expect(evaluateDelta(num('125.1'), 'mmol/L', r, prev('100'))?.detail).toContain('more than 25%');
    expect(evaluateDelta(num('75'), 'mmol/L', r, prev('100'))).toBeNull();
    expect(evaluateDelta(num('0.31'), 'mmol/L', R({ maxAbs: null, maxPercent: '2.5' }), prev('0.30'))?.flag).toBe('EXCEEDED');
    expect(evaluateDelta(num('0.1'), 'mmol/L', r, prev('0'))?.flag).toBe('EXCEEDED');
    expect(evaluateDelta(num('0'), 'mmol/L', r, prev('0'))).toBeNull();
  });

  it('names both limits when both are crossed', () => {
    expect(evaluateDelta(num('8'), 'mmol/L', R({ maxPercent: '50' }), prev('4'))?.detail).toBe('changed by 4 mmol/L from 4 (more than 1.0 mmol/L and more than 50%)');
  });

  it('does not compare across units, or without a rule, a previous value or numbers', () => {
    expect(evaluateDelta(num('5'), 'mg/dL', R(), prev('4'))?.flag).toBe('UNITS_DIFFER');
    expect(evaluateDelta(num('5'), 'mmol/L', R(), prev('4', null))?.detail).toContain('the previous in no units');
    expect(evaluateDelta(num('5'), 'mmol/L', null, prev('4'))).toBeNull();
    expect(evaluateDelta(num('5'), 'mmol/L', R(), null)).toBeNull();
    expect(evaluateDelta({ kind: 'censored', comparator: '<', limit: '1' }, 'mmol/L', R(), prev('4'))).toBeNull();
  });
});

describe('parseDeltaRule', () => {
  const base = { localTestCode: 'K', maxAbs: '1.0', maxPercent: '', windowDays: '7', units: 'mmol/L', reference: 'Lab policy DC-01 v1' };
  it('accepts a rule', () => {
    expect(parseDeltaRule({ ...base, maxPercent: '25 %' })).toEqual({ ok: true, value: { localTestCode: 'K', maxAbs: '1.0', maxPercent: '25', windowDays: 7, units: 'mmol/L', reference: 'Lab policy DC-01 v1' } });
  });
  it('explains every problem', () => {
    const r = parseDeltaRule({ localTestCode: '', maxAbs: '', maxPercent: '', windowDays: '0', units: '', reference: 'x' });
    expect(!r.ok && r.issues.length).toBe(5);
    const neg = parseDeltaRule({ ...base, maxAbs: '-1' });
    expect(!neg.ok && neg.issues).toEqual(['The largest change in units must be a number such as 0.8.']);
  });
});

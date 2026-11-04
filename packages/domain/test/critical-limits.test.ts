import { describe, expect, it } from 'vitest';
import { ageInDays, compareDecimal, describeAge, evaluateCritical, limitApplies, parseCriticalLimit, type CriticalLimit } from '../src/critical-limits.js';

// Limit values here are made up for the tests. They are not clinical guidance.
const L = (over: Partial<CriticalLimit> = {}): CriticalLimit => ({ id: 'l1', sex: null, ageMinDays: null, ageMaxDays: null, low: '2.5', high: '6.5', units: 'mmol/L', ...over });
const anyone = { sex: null, ageDays: null };
const num = (value: string) => ({ kind: 'numeric' as const, value, scale: value.split('.')[1]?.length ?? 0 });

describe('compareDecimal', () => {
  it('compares exactly, with signs and different scales', () => {
    expect(compareDecimal('2.50', '2.5')).toBe(0);
    expect(compareDecimal('2.49', '2.5')).toBe(-1);
    expect(compareDecimal('10', '9.999')).toBe(1);
    expect(compareDecimal('-0.1', '0')).toBe(-1);
    expect(compareDecimal('+3', '3.0')).toBe(0);
    expect(compareDecimal('0.30000000000000004', '0.3')).toBe(1);
    expect(() => compareDecimal('1e3', '1')).toThrow(/not a decimal/);
  });
});

describe('evaluateCritical', () => {
  it('flags strictly below low and strictly above high; the limit itself is not critical', () => {
    expect(evaluateCritical(num('2.4'), 'mmol/L', [L()], anyone)).toMatchObject({ flag: 'LOW', limitId: 'l1' });
    expect(evaluateCritical(num('2.50'), 'mmol/L', [L()], anyone)).toBeNull();
    expect(evaluateCritical(num('6.5'), 'mmol/L', [L()], anyone)).toBeNull();
    expect(evaluateCritical(num('6.51'), 'mmol/L', [L()], anyone)).toMatchObject({ flag: 'HIGH', detail: 'above the critical limit 6.5 mmol/L' });
    expect(evaluateCritical(num('9'), 'mmol/L', [L({ high: null })], anyone)).toBeNull();
  });

  it('counts censored values only when the bound settles it', () => {
    const c = (comparator: '<' | '<=' | '>' | '>=', limit: string) => ({ kind: 'censored' as const, comparator, limit });
    expect(evaluateCritical(c('<', '2.5'), 'mmol/L', [L()], anyone)?.flag).toBe('LOW');
    expect(evaluateCritical(c('<=', '2.5'), 'mmol/L', [L()], anyone)).toBeNull();
    expect(evaluateCritical(c('<', '3'), 'mmol/L', [L()], anyone)).toBeNull();
    expect(evaluateCritical(c('>', '6.5'), 'mmol/L', [L()], anyone)?.flag).toBe('HIGH');
    expect(evaluateCritical(c('>=', '6.5'), 'mmol/L', [L()], anyone)).toBeNull();
    expect(evaluateCritical(c('>=', '7'), 'mmol/L', [L()], anyone)?.flag).toBe('HIGH');
    expect(evaluateCritical(c('>', '1'), 'mmol/L', [L()], anyone)).toBeNull();
  });

  it('never compares across units, and says so', () => {
    expect(evaluateCritical(num('1'), 'mg/dL', [L()], anyone)).toMatchObject({ flag: 'UNITS_DIFFER' });
    expect(evaluateCritical(num('1'), undefined, [L()], anyone)?.detail).toContain('no units');
    // A crossed limit in matching units wins over a mismatch elsewhere.
    expect(evaluateCritical(num('1'), 'mmol/L', [L({ id: 'x', units: 'mg/dL' }), L()], anyone)).toMatchObject({ flag: 'LOW', limitId: 'l1' });
  });

  it('ignores qualitative, text and absent values', () => {
    expect(evaluateCritical({ kind: 'qualitative', code: 'POS' }, 'mmol/L', [L()], anyone)).toBeNull();
    expect(evaluateCritical({ kind: 'absent', reason: 'not-performed' }, 'mmol/L', [L()], anyone)).toBeNull();
  });

  it('applies limits by sex and age, and applies all of them when either is unknown', () => {
    const newborn = L({ id: 'nb', ageMaxDays: 28, low: '1.0' });
    const adultF = L({ id: 'f', sex: 'F', ageMinDays: 18 * 365 });
    expect(limitApplies(newborn, { sex: 'F', ageDays: 10 })).toBe(true);
    expect(limitApplies(newborn, { sex: 'F', ageDays: 28 })).toBe(false);
    expect(limitApplies(adultF, { sex: 'M', ageDays: 9000 })).toBe(false);
    expect(limitApplies(adultF, { sex: 'U', ageDays: 9000 })).toBe(true);
    expect(limitApplies(adultF, { sex: 'F', ageDays: null })).toBe(true);
    expect(evaluateCritical(num('2'), 'mmol/L', [newborn], { sex: null, ageDays: 5 })).toBeNull();
    expect(evaluateCritical(num('2'), 'mmol/L', [newborn, adultF], { sex: null, ageDays: null })?.limitId).toBe('f');
  });
});

describe('ageInDays', () => {
  it('counts whole days, and gives nothing for a missing or later birth date', () => {
    expect(ageInDays(new Date('2026-11-01'), new Date('2026-11-04T23:00:00Z'))).toBe(3);
    expect(ageInDays(null, new Date())).toBeNull();
    expect(ageInDays(new Date('2027-01-01'), new Date('2026-11-04'))).toBeNull();
  });
});

describe('parseCriticalLimit', () => {
  const base = { localTestCode: 'K', sex: '', ageMin: '', ageMinUnit: 'years', ageMax: '', ageMaxUnit: 'years', low: '2.5', high: '6.5', units: 'mmol/L', reference: 'Lab policy CP-01 v1' };
  it('accepts a limit and converts ages to days', () => {
    const r = parseCriticalLimit({ ...base, ageMin: '1', ageMinUnit: 'months', ageMax: '18', sex: 'F' });
    expect(r).toEqual({ ok: true, value: { localTestCode: 'K', sex: 'F', ageMinDays: 30, ageMaxDays: 18 * 365, low: '2.5', high: '6.5', units: 'mmol/L', reference: 'Lab policy CP-01 v1' } });
  });
  it('explains every problem', () => {
    const r = parseCriticalLimit({ ...base, localTestCode: '', sex: 'X', low: '7', high: '6.5', units: '', reference: 'x', ageMin: '5', ageMax: '2' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues).toEqual(expect.arrayContaining(['Choose the test.', 'The low limit must be below the high limit.', '"Age from" must be below "age up to".']));
      expect(r.issues.length).toBe(6);
    }
    const none = parseCriticalLimit({ ...base, low: '', high: '' });
    expect(!none.ok && none.issues).toEqual(['Enter a low limit, a high limit, or both.']);
    const words = parseCriticalLimit({ ...base, low: 'two' });
    expect(!words.ok && words.issues[0]).toContain('number');
  });
  it('describes age bands', () => {
    expect(describeAge(null, null)).toBe('all ages');
    expect(describeAge(null, 28)).toBe('under 28 days');
    expect(describeAge(30, 18 * 365)).toBe('1 month to under 18 years');
    expect(describeAge(6570, null)).toBe('from 18 years');
  });
});

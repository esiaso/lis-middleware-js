import { describe, expect, it } from 'vitest';
import { describeReference, parseReferenceRange, referenceFor, referenceMark, type ReferenceRange } from '../src/index.js';

// Values are made up for the tests. They are not from any insert.
const R = (over: Partial<ReferenceRange> = {}): ReferenceRange => ({ id: 'r', sex: null, ageMinDays: null, ageMaxDays: null, low: '3.5', high: '5.1', units: 'mmol/L', ...over });
const num = (value: string) => ({ kind: 'numeric' as const, value, scale: 1 });

describe('reference ranges', () => {
  it('applies a range only when it certainly fits the patient, most specific first', () => {
    const all = R({ id: 'all' });
    const male = R({ id: 'male', sex: 'M' });
    const maleAdult = R({ id: 'maleAdult', sex: 'M', ageMinDays: 18 * 365 });
    const child = R({ id: 'child', ageMaxDays: 18 * 365 });
    const ranges = [all, male, maleAdult, child];
    expect(referenceFor(ranges, { sex: 'M', ageDays: 40 * 365 })?.id).toBe('maleAdult');
    expect(referenceFor(ranges, { sex: 'M', ageDays: 10 * 365 })?.id).toBe('male');
    expect(referenceFor(ranges, { sex: 'F', ageDays: 10 * 365 })?.id).toBe('child');
    expect(referenceFor(ranges, { sex: 'M', ageDays: null })?.id).toBe('male'); // no age: no age band
    expect(referenceFor(ranges, { sex: null, ageDays: null })?.id).toBe('all'); // no sex: no sex-specific range
    expect(referenceFor([male, child], { sex: null, ageDays: null })).toBeNull();
    // Of two age bands that fit, the narrower wins.
    expect(referenceFor([R({ id: 'wide', ageMaxDays: 18 * 365 }), R({ id: 'narrow', ageMaxDays: 28 })], { sex: null, ageDays: 10 })?.id).toBe('narrow');
  });

  it('marks values below, within or above, both ends included', () => {
    expect(referenceMark(num('3.5'), 'mmol/L', R())).toBe('WITHIN');
    expect(referenceMark(num('5.1'), 'mmol/L', R())).toBe('WITHIN');
    expect(referenceMark(num('3.4'), 'mmol/L', R())).toBe('BELOW');
    expect(referenceMark(num('5.2'), 'mmol/L', R())).toBe('ABOVE');
    expect(referenceMark(num('5.2'), 'mg/dL', R())).toBe('UNITS_DIFFER');
    expect(referenceMark({ kind: 'censored', comparator: '<', limit: '3.5' }, 'mmol/L', R())).toBe('BELOW');
    expect(referenceMark({ kind: 'censored', comparator: '<', limit: '4.0' }, 'mmol/L', R())).toBeNull();
    expect(referenceMark({ kind: 'censored', comparator: '>', limit: '5.1' }, 'mmol/L', R())).toBe('ABOVE');
    expect(referenceMark({ kind: 'qualitative', code: 'POS' }, 'mmol/L', R())).toBeNull();
    expect(referenceMark(num('9'), 'mmol/L', R({ low: null }))).toBe('ABOVE');
  });

  it('describes and checks a range', () => {
    expect(describeReference(R())).toBe('3.5 to 5.1 mmol/L');
    expect(describeReference(R({ low: null, high: '5.2' }))).toBe('up to 5.2 mmol/L');
    expect(describeReference(R({ high: null }))).toBe('from 3.5 mmol/L');
    const base = { localTestCode: 'K', sex: '', ageMin: '', ageMinUnit: 'years', ageMax: '', ageMaxUnit: 'years', low: '3.5', high: '5.1', units: 'mmol/L', reference: 'Lab ranges v1' };
    expect(parseReferenceRange(base)).toMatchObject({ ok: true, value: { sex: null, ageMinDays: null, low: '3.5' } });
    expect(parseReferenceRange({ ...base, low: '5.1', high: '5.1' }).ok).toBe(true); // a single value is allowed
    expect(parseReferenceRange({ ...base, low: '', high: '' })).toMatchObject({ ok: false });
    expect(parseReferenceRange({ ...base, ageMin: '1', ageMinUnit: 'years', ageMax: '6', ageMaxUnit: 'months' })).toMatchObject({ ok: false, issues: ['"Age from" must be below "age up to".'] });
  });
});

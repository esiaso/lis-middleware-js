import { describe, expect, it } from 'vitest';
import { AUTOVERIFY_ACTOR, autoverifyResult, evaluateAutoverification, newResult, parseAutoverifyRule, type AutoverifyInput } from '../src/index.js';

// Rule values here are made up for the tests. They are not clinical guidance.
const rule = { id: 'r1', low: '3.5', high: '5.0', units: 'mmol/L' };
const num = (value: string) => ({ kind: 'numeric' as const, value, scale: value.split('.')[1]?.length ?? 0 });
const ok = (over: Partial<AutoverifyInput> = {}): AutoverifyInput => ({
  kind: 'initial', value: num('4.2'), units: 'mmol/L', abnormalFlags: [], instrumentFlags: [], editedOnInstrument: false, criticalFlag: null, deltaFlag: null, qc: null, instrumentCleared: true, ...over,
});
const failed = (i: AutoverifyInput) => evaluateAutoverification(rule, i).checks.filter((c) => !c.ok).map((c) => c.check);

describe('evaluateAutoverification', () => {
  it('passes a clean first value inside the range, both ends included', () => {
    expect(evaluateAutoverification(rule, ok()).passed).toBe(true);
    expect(evaluateAutoverification(rule, ok({ value: num('3.50') })).passed).toBe(true);
    expect(evaluateAutoverification(rule, ok({ value: num('5.0') })).passed).toBe(true);
    expect(failed(ok({ value: num('5.01') }))).toEqual(['range']);
    expect(failed(ok({ value: num('3.49') }))).toEqual(['range']);
  });

  it('holds anything in doubt, and lists every reason', () => {
    expect(failed(ok({ kind: 'repeat' }))).toEqual(['first value']);
    expect(failed(ok({ instrumentCleared: false }))).toEqual(['instrument cleared']);
    expect(failed(ok({ units: 'mg/dL' }))).toEqual(['units']);
    expect(failed(ok({ units: null }))).toEqual(['units']);
    expect(failed(ok({ abnormalFlags: ['H'] }))).toEqual(['abnormal flags']);
    expect(failed(ok({ instrumentFlags: ['>Test'] }))).toEqual(['instrument flags']);
    expect(failed(ok({ editedOnInstrument: true }))).toEqual(['not edited']);
    expect(failed(ok({ criticalFlag: 'UNITS_DIFFER' }))).toEqual(['not critical']);
    expect(failed(ok({ deltaFlag: 'EXCEEDED' }))).toEqual(['delta check']);
    expect(failed(ok({ qc: { ok: false, detail: 'no checked QC result in the last 8 h' } }))).toEqual(['QC']);
    expect(failed(ok({ qc: { ok: true, detail: '2 controls in range' } }))).toEqual([]);
    expect(failed(ok({ value: { kind: 'censored', comparator: '<', limit: '4' } }))).toEqual(['numeric value', 'range']);
    expect(failed(ok({ kind: 'dilution', value: num('9'), abnormalFlags: ['H'], criticalFlag: 'HIGH' }))).toEqual(['first value', 'range', 'abnormal flags', 'not critical']);
  });
});

describe('autoverifyResult', () => {
  it('approves only an untouched first value', () => {
    const a = newResult('res', { kind: 'initial', value: num('4.2'), abnormalFlags: [], createdBy: 'system:c111' });
    const r = autoverifyResult(a);
    expect(r.ok && r.value).toMatchObject({ status: 'approved', approvedBy: AUTOVERIFY_ACTOR, reviewedBy: AUTOVERIFY_ACTOR });
    expect(autoverifyResult({ ...a, status: 'reviewed' }).ok).toBe(false);
    expect(autoverifyResult({ ...a, versions: [...a.versions, { ...a.versions[0]!, versionNo: 2 }], selectedVersionNo: 2 }).ok).toBe(false);
  });
});

describe('parseAutoverifyRule', () => {
  const base = { localTestCode: 'K', low: '3.5', high: '5.0', units: 'mmol/L', reference: 'Validation AV-K v1', qcAcknowledged: true };
  it('accepts a rule and trims it', () => {
    expect(parseAutoverifyRule({ ...base, low: ' 3.5 ' })).toEqual({ ok: true, value: { localTestCode: 'K', low: '3.5', high: '5.0', units: 'mmol/L', reference: 'Validation AV-K v1', qcWithinHours: null } });
    expect(parseAutoverifyRule({ ...base, low: '5', high: '5' }).ok).toBe(true);
    const r = parseAutoverifyRule({ ...base, qcWithinHours: '8' });
    expect(r.ok && r.value.qcWithinHours).toBe(8);
    expect(parseAutoverifyRule({ ...base, qcWithinHours: '200' }).ok).toBe(false);
  });
  it('requires both bounds, the report and the QC confirmation', () => {
    const r = parseAutoverifyRule({ localTestCode: '', low: '', high: 'x', units: '', reference: 'v1', qcAcknowledged: false });
    expect(!r.ok && r.issues.length).toBe(6);
    const crossed = parseAutoverifyRule({ ...base, low: '6' });
    expect(!crossed.ok && crossed.issues).toEqual(['The lowest value must not be above the highest.']);
  });
});

import type { ResultValue } from '@lis/contracts';
import { compareDecimal, describeAge, isDecimal } from './critical-limits.js';

/**
 * Reference ranges entered by the lab (A-25), for tests whose instruments
 * send none or where the lab's own ranges apply. None are shipped. A range
 * is inclusive at both ends. Unlike critical limits, a range applies only
 * when it certainly fits the patient: a sex-specific range needs the
 * patient's sex, an age band needs the birth date, so an unknown patient
 * never gets a range meant for someone else. The most specific range wins.
 * The mark it gives (below or above the range) is shown to people only; it
 * is not stored, sent to the HMIS, or used by autoverification, which goes
 * by the instrument's own flags.
 */
export interface ReferenceRange {
  id: string;
  sex: string | null;
  ageMinDays: number | null;
  ageMaxDays: number | null;
  low: string | null;
  high: string | null;
  units: string;
}

export interface ReferenceSubject {
  sex: string | null;
  ageDays: number | null;
}

export function referenceApplies(r: ReferenceRange, s: ReferenceSubject): boolean {
  if (r.sex && r.sex !== s.sex) return false;
  if (r.ageMinDays !== null || r.ageMaxDays !== null) {
    if (s.ageDays === null) return false;
    if (r.ageMinDays !== null && s.ageDays < r.ageMinDays) return false;
    if (r.ageMaxDays !== null && s.ageDays >= r.ageMaxDays) return false;
  }
  return true;
}

/** The most specific applicable range: sex and age, then sex or age, then neither; ties go to the narrower age band. */
export function referenceFor<T extends ReferenceRange>(ranges: T[], s: ReferenceSubject): T | null {
  const score = (r: ReferenceRange) => (r.sex ? 2 : 0) + (r.ageMinDays !== null || r.ageMaxDays !== null ? 1 : 0);
  const width = (r: ReferenceRange) => (r.ageMaxDays ?? 100_000) - (r.ageMinDays ?? 0);
  return ranges.filter((r) => referenceApplies(r, s)).sort((a, b) => score(b) - score(a) || width(a) - width(b))[0] ?? null;
}

export type ReferenceMark = 'BELOW' | 'ABOVE' | 'WITHIN' | 'UNITS_DIFFER' | null;

/** Where a value sits against the range. Null when it cannot be compared (not a number, or a censored value the bound does not settle). */
export function referenceMark(v: ResultValue, units: string | null | undefined, r: ReferenceRange): ReferenceMark {
  if (v.kind !== 'numeric' && v.kind !== 'censored') return null;
  if ((units ?? '').trim() !== r.units.trim()) return 'UNITS_DIFFER';
  if (v.kind === 'numeric') {
    if (r.low !== null && compareDecimal(v.value, r.low) < 0) return 'BELOW';
    if (r.high !== null && compareDecimal(v.value, r.high) > 0) return 'ABOVE';
    return 'WITHIN';
  }
  const below = v.comparator === '<' || v.comparator === '<=';
  if (below && r.low !== null) {
    const c = compareDecimal(v.limit, r.low);
    if (c < 0 || (c === 0 && v.comparator === '<')) return 'BELOW';
  }
  if (!below && r.high !== null) {
    const c = compareDecimal(v.limit, r.high);
    if (c > 0 || (c === 0 && v.comparator === '>')) return 'ABOVE';
  }
  return null;
}

/** "3.5 to 5.1 mmol/L", "below 5.0 mmol/L" (wording for an open end: "up to", "from"). */
export function describeReference(r: ReferenceRange): string {
  if (r.low !== null && r.high !== null) return `${r.low} to ${r.high} ${r.units}`;
  if (r.high !== null) return `up to ${r.high} ${r.units}`;
  return `from ${r.low} ${r.units}`;
}

export const describeReferenceWho = (r: ReferenceRange) => `${r.sex === 'F' ? 'female' : r.sex === 'M' ? 'male' : 'everyone'}, ${describeAge(r.ageMinDays, r.ageMaxDays)}`;

export interface ReferenceRangeInput {
  localTestCode: string;
  sex: string;
  ageMin: string;
  ageMinUnit: string;
  ageMax: string;
  ageMaxUnit: string;
  low: string;
  high: string;
  units: string;
  reference: string;
}

const AGE_UNIT: Record<string, number> = { days: 1, months: 30, years: 365 };

export function parseReferenceRange(i: ReferenceRangeInput): { ok: true; value: Omit<ReferenceRange, 'id'> & { localTestCode: string; reference: string } } | { ok: false; issues: string[] } {
  const issues: string[] = [];
  const low = i.low.trim();
  const high = i.high.trim();
  if (!i.localTestCode.trim()) issues.push('Choose the test.');
  if (i.sex && i.sex !== 'F' && i.sex !== 'M') issues.push('Sex must be F, M or everyone.');
  if (!low && !high) issues.push('Enter the lower limit, the upper limit, or both.');
  if (low && !isDecimal(low)) issues.push('The lower limit must be a number such as 3.5.');
  if (high && !isDecimal(high)) issues.push('The upper limit must be a number such as 5.1.');
  if (low && high && isDecimal(low) && isDecimal(high) && compareDecimal(low, high) > 0) issues.push('The lower limit must not be above the upper limit.');
  if (!i.units.trim() || i.units.trim().length > 20) issues.push('Units: 1 to 20 characters, exactly as the instrument reports them.');
  if (i.reference.trim().length < 5 || i.reference.trim().length > 200) issues.push('Source: 5 to 200 characters, for example the lab\'s verified ranges document and its version, or the reagent insert.');
  const age = (n: string, unit: string, label: string): number | null => {
    if (!n.trim()) return null;
    const mult = AGE_UNIT[unit];
    if (!/^\d{1,3}$/.test(n.trim()) || !mult) {
      issues.push(`${label} must be a whole number of days, months or years.`);
      return null;
    }
    return Number(n.trim()) * mult;
  };
  const ageMinDays = age(i.ageMin, i.ageMinUnit, 'Age from');
  const ageMaxDays = age(i.ageMax, i.ageMaxUnit, 'Age up to');
  if (ageMinDays !== null && ageMaxDays !== null && ageMinDays >= ageMaxDays) issues.push('"Age from" must be below "age up to".');
  if (issues.length) return { ok: false, issues };
  return { ok: true, value: { localTestCode: i.localTestCode.trim(), sex: i.sex || null, ageMinDays, ageMaxDays, low: low || null, high: high || null, units: i.units.trim(), reference: i.reference.trim() } };
}

import type { ResultValue } from '@lis/contracts';

/**
 * Critical (panic) limits (08 §12). The lab director sets every limit; the
 * middleware ships with none and never suggests values. A value is critical
 * when it is strictly below `low` or strictly above `high` (A-18).
 */
export interface CriticalLimit {
  id: string;
  /** F or M; null applies to everyone. */
  sex: string | null;
  /** Age at collection in days: from ageMinDays (inclusive) to ageMaxDays (exclusive). Null is open-ended. */
  ageMinDays: number | null;
  ageMaxDays: number | null;
  low: string | null;
  high: string | null;
  units: string;
}

export interface CriticalSubject {
  sex: string | null;
  ageDays: number | null;
}

/**
 * LOW, HIGH and ANSWER (a catalogue answer the lab made critical, such as a
 * positive malaria smear, A-36) need a recorded call before approval;
 * UNITS_DIFFER asks a person to compare by hand.
 */
export type CriticalFlag = 'LOW' | 'HIGH' | 'UNITS_DIFFER' | 'ANSWER';

/** The word to show next to "critical" for a flag that needs a call, or '' when it needs none. */
export function criticalLabel(flag: string | null | undefined): string {
  if (flag === 'LOW' || flag === 'HIGH') return flag;
  if (flag === 'ANSWER') return 'answer';
  return '';
}

export interface CriticalOutcome {
  flag: CriticalFlag;
  /** The critical limit that fired; null for a critical answer, which lives on the catalogue. */
  limitId: string | null;
  detail: string;
}

const DECIMAL = /^[+-]?\d+(\.\d+)?$/;
export const isDecimal = (s: string) => DECIMAL.test(s);

/** Exact comparison of two decimal strings, no floating point. */
export function compareDecimal(a: string, b: string): number {
  if (!isDecimal(a) || !isDecimal(b)) throw new Error(`not a decimal: ${isDecimal(a) ? b : a}`);
  const split = (s: string) => {
    const neg = s.startsWith('-');
    const [i, f = ''] = s.replace(/^[+-]/, '').split('.') as [string, string?];
    return { neg, i, f };
  };
  const x = split(a);
  const y = split(b);
  const scale = Math.max(x.f.length, y.f.length);
  const big = (p: { neg: boolean; i: string; f: string }) => (p.neg ? -1n : 1n) * BigInt(p.i + p.f.padEnd(scale, '0'));
  const d = big(x) - big(y);
  return d < 0n ? -1 : d > 0n ? 1 : 0;
}

/** Does this limit cover this patient? Unknown sex or age counts as covered, so nothing critical is missed. */
export function limitApplies(l: CriticalLimit, s: CriticalSubject): boolean {
  if (l.sex && s.sex && (s.sex === 'F' || s.sex === 'M') && l.sex !== s.sex) return false;
  if (s.ageDays !== null) {
    if (l.ageMinDays !== null && s.ageDays < l.ageMinDays) return false;
    if (l.ageMaxDays !== null && s.ageDays >= l.ageMaxDays) return false;
  }
  return true;
}

const normUnits = (u: string | undefined | null) => (u ?? '').trim();

/** Is the value certainly below `low` / above `high`? Censored values count only when the bound itself settles it. */
function crosses(v: ResultValue, l: CriticalLimit): 'LOW' | 'HIGH' | null {
  if (v.kind === 'numeric') {
    if (l.low !== null && compareDecimal(v.value, l.low) < 0) return 'LOW';
    if (l.high !== null && compareDecimal(v.value, l.high) > 0) return 'HIGH';
    return null;
  }
  if (v.kind === 'censored') {
    // "<X": the value is below X (or at most X for "<="). It is certainly below low when X <= low ("<") or X < low ("<=").
    if ((v.comparator === '<' || v.comparator === '<=') && l.low !== null) {
      const c = compareDecimal(v.limit, l.low);
      if (c < 0 || (c === 0 && v.comparator === '<')) return 'LOW';
    }
    if ((v.comparator === '>' || v.comparator === '>=') && l.high !== null) {
      const c = compareDecimal(v.limit, l.high);
      if (c > 0 || (c === 0 && v.comparator === '>')) return 'HIGH';
    }
  }
  return null;
}

/**
 * Check one value against the active limits for its test. A crossed limit
 * wins over a units mismatch; among crossed limits the first (by the order
 * given) is reported. Only numeric and censored values have limits.
 */
export function evaluateCritical(value: ResultValue, units: string | undefined | null, limits: CriticalLimit[], subject: CriticalSubject): CriticalOutcome | null {
  if (value.kind !== 'numeric' && value.kind !== 'censored') return null;
  let mismatch: CriticalOutcome | null = null;
  for (const l of limits) {
    if (!limitApplies(l, subject)) continue;
    if (normUnits(l.units) !== normUnits(units)) {
      mismatch ??= { flag: 'UNITS_DIFFER', limitId: l.id, detail: `the critical limit is in ${l.units} but the result is in ${normUnits(units) || 'no units'}; compare by hand` };
      continue;
    }
    const c = crosses(value, l);
    if (c) return { flag: c, limitId: l.id, detail: c === 'LOW' ? `below the critical limit ${l.low} ${l.units}` : `above the critical limit ${l.high} ${l.units}` };
  }
  return mismatch;
}

/** Age in whole days at a moment, or null when the birth date is unknown or after it. */
export function ageInDays(birthDate: Date | null, at: Date): number | null {
  if (!birthDate) return null;
  const d = Math.floor((Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()) - Date.UTC(birthDate.getUTCFullYear(), birthDate.getUTCMonth(), birthDate.getUTCDate())) / 86_400_000);
  return d >= 0 ? d : null;
}

export interface CriticalLimitInput {
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

/** Check a limit typed into the form. Returns the stored shape or the problems, in plain words. */
export function parseCriticalLimit(i: CriticalLimitInput): { ok: true; value: Omit<CriticalLimit, 'id'> & { localTestCode: string; reference: string } } | { ok: false; issues: string[] } {
  const issues: string[] = [];
  const low = i.low.trim();
  const high = i.high.trim();
  if (!i.localTestCode.trim()) issues.push('Choose the test.');
  if (i.sex && i.sex !== 'F' && i.sex !== 'M') issues.push('Sex must be F, M or everyone.');
  if (!low && !high) issues.push('Enter a low limit, a high limit, or both.');
  if (low && !isDecimal(low)) issues.push('The low limit must be a number such as 2.5.');
  if (high && !isDecimal(high)) issues.push('The high limit must be a number such as 6.5.');
  if (low && high && isDecimal(low) && isDecimal(high) && compareDecimal(low, high) >= 0) issues.push('The low limit must be below the high limit.');
  if (!i.units.trim() || i.units.trim().length > 20) issues.push('Units: 1 to 20 characters, exactly as the instrument reports them.');
  if (i.reference.trim().length < 5 || i.reference.trim().length > 200) issues.push('Source: 5 to 200 characters naming the lab policy or document the limit comes from.');
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
  return {
    ok: true,
    value: { localTestCode: i.localTestCode.trim(), sex: i.sex || null, ageMinDays, ageMaxDays, low: low || null, high: high || null, units: i.units.trim(), reference: i.reference.trim() },
  };
}

/** "0 days to 28 days", "from 18 years", "all ages". Months and years are 30 and 365 days. */
export function describeAge(min: number | null, max: number | null): string {
  const n = (k: number, unit: string) => `${k} ${unit}${k === 1 ? '' : 's'}`;
  const fmt = (d: number) => (d % 365 === 0 && d > 0 ? n(d / 365, 'year') : d % 30 === 0 && d > 0 ? n(d / 30, 'month') : n(d, 'day'));
  if (min === null && max === null) return 'all ages';
  if (min === null) return `under ${fmt(max!)}`;
  if (max === null) return `from ${fmt(min)}`;
  return `${fmt(min)} to under ${fmt(max)}`;
}

/**
 * How soon a critical result must be phoned (A-37): minutes from the moment
 * the critical version arrives. A target for one test beats the lab-wide one
 * (localTestCode null). The lab sets every target; there is no default.
 */
export interface CallTarget {
  localTestCode: string | null;
  minutes: number;
}

export function callTargetFor<T extends CallTarget>(targets: readonly T[], test: string): T | null {
  return targets.find((t) => t.localTestCode === test) ?? targets.find((t) => t.localTestCode === null) ?? null;
}

export interface CallTargetInput {
  localTestCode: string;
  minutes: string;
  reference: string;
}

export function parseCallTarget(i: CallTargetInput): { ok: true; value: { localTestCode: string | null; minutes: number; reference: string } } | { ok: false; issues: string[] } {
  const issues: string[] = [];
  const m = i.minutes.trim();
  if (!/^\d{1,4}$/.test(m) || Number(m) < 1 || Number(m) > 1440) issues.push('Target: 1 to 1440 minutes (24 hours).');
  const reference = i.reference.trim();
  if (reference.length < 5 || reference.length > 200) issues.push('Source: 5 to 200 characters naming the lab policy and its version.');
  if (issues.length) return { ok: false, issues };
  return { ok: true, value: { localTestCode: i.localTestCode.trim() || null, minutes: Number(m), reference } };
}

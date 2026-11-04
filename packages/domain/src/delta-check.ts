import type { ResultValue } from '@lis/contracts';
import { isDecimal } from './critical-limits.js';

/**
 * Delta check (08 §12, A-20): compare a new value with the patient's last
 * approved value for the same test. The lab sets the allowed change per test;
 * the middleware ships with none. A flag asks a person to look (a sample
 * from the wrong patient, a drip arm, a real change); it does not block
 * approval, but autoverification holds any flagged value.
 */
export interface DeltaRule {
  id: string;
  /** Largest allowed change in the rule's units, or null. */
  maxAbs: string | null;
  /** Largest allowed change as a percentage of the previous value, or null. */
  maxPercent: string | null;
  windowDays: number;
  units: string;
}

export interface PreviousValue {
  resultId: string;
  value: ResultValue;
  units: string | null;
  collectedAt: Date;
}

export type DeltaFlag = 'EXCEEDED' | 'UNITS_DIFFER';

export interface DeltaOutcome {
  flag: DeltaFlag;
  ruleId: string;
  previousResultId: string;
  detail: string;
}

/** A decimal string as an integer at a given scale, exactly. */
function scaled(s: string, scale: number): bigint {
  const neg = s.startsWith('-');
  const [i, f = ''] = s.replace(/^[+-]/, '').split('.') as [string, string?];
  return (neg ? -1n : 1n) * BigInt(i + f.padEnd(scale, '0'));
}
const fraction = (s: string) => s.split('.')[1]?.length ?? 0;
const abs = (n: bigint) => (n < 0n ? -n : n);

/** |a - b| as a decimal string, exactly. */
export function absDifference(a: string, b: string): string {
  const scale = Math.max(fraction(a), fraction(b));
  const d = abs(scaled(a, scale) - scaled(b, scale)).toString().padStart(scale + 1, '0');
  return scale ? `${d.slice(0, -scale)}.${d.slice(-scale)}` : d;
}

/**
 * Null when there is nothing to compare: no rule, no earlier value inside the
 * window, or either value not a plain number. Over the limit means strictly
 * greater than it.
 */
export function evaluateDelta(value: ResultValue, units: string | null | undefined, rule: DeltaRule | null, previous: PreviousValue | null): DeltaOutcome | null {
  if (!rule || !previous || value.kind !== 'numeric' || previous.value.kind !== 'numeric') return null;
  const base = { ruleId: rule.id, previousResultId: previous.resultId };
  const u = (units ?? '').trim();
  const pu = (previous.units ?? '').trim();
  if (u !== rule.units.trim() || pu !== rule.units.trim()) {
    return { ...base, flag: 'UNITS_DIFFER', detail: `not compared: this value is in ${u || 'no units'}, the previous in ${pu || 'no units'}, the rule is for ${rule.units}` };
  }
  const now = value.value;
  const before = previous.value.value;
  const diff = absDifference(now, before);
  const over: string[] = [];
  if (rule.maxAbs !== null) {
    const s = Math.max(fraction(diff), fraction(rule.maxAbs));
    if (scaled(diff, s) > scaled(rule.maxAbs, s)) over.push(`more than ${rule.maxAbs} ${rule.units}`);
  }
  if (rule.maxPercent !== null) {
    // diff * 100 > pct * |before|, all at one scale. A previous value of 0 makes any change exceed it.
    const s = Math.max(fraction(diff), fraction(before)) + fraction(rule.maxPercent);
    const lhs = scaled(diff, s) * 100n * 10n ** BigInt(fraction(rule.maxPercent));
    const rhs = scaled(rule.maxPercent, fraction(rule.maxPercent)) * abs(scaled(before, s));
    if (lhs > rhs) over.push(`more than ${rule.maxPercent}%`);
  }
  if (!over.length) return null;
  return { ...base, flag: 'EXCEEDED', detail: `changed by ${diff} ${rule.units} from ${before} (${over.join(' and ')})` };
}

export interface DeltaRuleInput {
  localTestCode: string;
  maxAbs: string;
  maxPercent: string;
  windowDays: string;
  units: string;
  reference: string;
}

export function parseDeltaRule(i: DeltaRuleInput): { ok: true; value: { localTestCode: string; maxAbs: string | null; maxPercent: string | null; windowDays: number; units: string; reference: string } } | { ok: false; issues: string[] } {
  const issues: string[] = [];
  const maxAbs = i.maxAbs.trim();
  const maxPercent = i.maxPercent.trim().replace(/%$/, '').trim();
  const days = i.windowDays.trim();
  const unsigned = (s: string) => isDecimal(s) && !/^[+-]/.test(s);
  if (!i.localTestCode.trim()) issues.push('Choose the test.');
  if (!maxAbs && !maxPercent) issues.push('Enter a largest change in units, as a percentage, or both.');
  if (maxAbs && !unsigned(maxAbs)) issues.push('The largest change in units must be a number such as 0.8.');
  if (maxPercent && !unsigned(maxPercent)) issues.push('The largest change as a percentage must be a number such as 25.');
  if (!/^\d{1,4}$/.test(days) || Number(days) < 1 || Number(days) > 3650) issues.push('Compare with results from the last 1 to 3650 days.');
  if (!i.units.trim() || i.units.trim().length > 20) issues.push('Units: 1 to 20 characters, exactly as the instrument reports them.');
  if (i.reference.trim().length < 5 || i.reference.trim().length > 200) issues.push('Source: 5 to 200 characters naming the lab document and its version.');
  if (issues.length) return { ok: false, issues };
  return { ok: true, value: { localTestCode: i.localTestCode.trim(), maxAbs: maxAbs || null, maxPercent: maxPercent || null, windowDays: Number(days), units: i.units.trim(), reference: i.reference.trim() } };
}

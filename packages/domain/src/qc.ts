import type { ResultValue } from '@lis/contracts';
import { compareDecimal, isDecimal } from './critical-limits.js';
import { parseWestgard, type WestgardRule } from './westgard.js';

/**
 * QC log (08 §12, A-21). Instruments already send their QC results; the
 * middleware keeps them apart from patient results (T-16) and checks each
 * one against the acceptable range the lab enters for that instrument, test
 * and control. It ships with no ranges. A range may also carry the
 * control's target mean and SD and the Westgard rules the lab chose
 * (westgard.ts, A-23); a value inside the range that breaks a rejection
 * rule is RULE_VIOLATION.
 */
export interface QcRange {
  id: string;
  /** Control lot as the instrument reports it, or null for any lot. */
  controlLot: string | null;
  /** Control name (or the QC sample ID, for generic profiles), or null for any. */
  controlName: string | null;
  low: string;
  high: string;
  units: string;
}

export interface QcControl {
  lot?: string | undefined;
  controlName?: string | undefined;
  level?: string | undefined;
}

export type QcOutcomeKind = 'IN_RANGE' | 'OUT_OF_RANGE' | 'RULE_VIOLATION' | 'UNITS_DIFFER' | 'NO_RANGE' | 'NOT_NUMERIC';

export interface QcOutcome {
  outcome: QcOutcomeKind;
  rangeId: string | null;
  detail: string;
}

const same = (a: string | null, b: string | undefined) => a === null || (b ?? '').trim() === a.trim();
export const qcRangeApplies = (r: QcRange, c: QcControl) => same(r.controlLot, c.lot) && same(r.controlName, c.controlName);

/** The most specific applicable range wins: lot and name, then one of them. */
export function evaluateQc(value: ResultValue, units: string | null | undefined, ranges: QcRange[], c: QcControl): QcOutcome {
  const applicable = ranges.filter((r) => qcRangeApplies(r, c)).sort((a, b) => Number(b.controlLot !== null) + Number(b.controlName !== null) - (Number(a.controlLot !== null) + Number(a.controlName !== null)));
  const r = applicable[0];
  const who = [c.controlName, c.lot && `lot ${c.lot}`].filter(Boolean).join(', ') || 'unnamed control';
  if (!r) return { outcome: 'NO_RANGE', rangeId: null, detail: `no range for ${who}` };
  if (value.kind !== 'numeric') return { outcome: 'NOT_NUMERIC', rangeId: r.id, detail: `a ${value.kind} value, not compared` };
  const u = (units ?? '').trim();
  if (u !== r.units.trim()) return { outcome: 'UNITS_DIFFER', rangeId: r.id, detail: `in ${u || 'no units'}, the range is for ${r.units}` };
  const v = value.value;
  if (compareDecimal(v, r.low) < 0 || compareDecimal(v, r.high) > 0) return { outcome: 'OUT_OF_RANGE', rangeId: r.id, detail: `${v} outside ${r.low} to ${r.high} ${r.units}` };
  return { outcome: 'IN_RANGE', rangeId: r.id, detail: `${v} within ${r.low} to ${r.high} ${r.units}` };
}

/** Outcomes a person must act on. */
export const QC_FAILED: readonly QcOutcomeKind[] = ['OUT_OF_RANGE', 'RULE_VIOLATION', 'UNITS_DIFFER'];

/**
 * Whether QC supports autoverifying a result now: within the window there is
 * at least one checked control, and the latest result for each control's
 * range is in range. Results without a range, or not numeric, count for
 * nothing either way.
 */
export function qcSupports(evals: { rangeId: string | null; outcome: QcOutcomeKind; at: Date }[], hours: number): { ok: boolean; detail: string } {
  const latest = new Map<string, { outcome: QcOutcomeKind; at: Date }>();
  for (const e of evals) {
    if (!e.rangeId || e.outcome === 'NO_RANGE' || e.outcome === 'NOT_NUMERIC') continue;
    const prev = latest.get(e.rangeId);
    if (!prev || prev.at < e.at) latest.set(e.rangeId, e);
  }
  if (!latest.size) return { ok: false, detail: `no checked QC result in the last ${hours} h` };
  const bad = [...latest.values()].filter((e) => e.outcome !== 'IN_RANGE').length;
  if (bad) return { ok: false, detail: `${bad} of ${latest.size} control${latest.size === 1 ? '' : 's'} failed the latest QC` };
  return { ok: true, detail: `${latest.size} control${latest.size === 1 ? '' : 's'} in range in the last ${hours} h` };
}

export interface QcRangeInput {
  instrumentId: string;
  localTestCode: string;
  controlLot: string;
  controlName: string;
  low: string;
  high: string;
  units: string;
  reference: string;
  /** Optional, both or neither: the control's target mean and SD. */
  targetMean?: string | undefined;
  targetSd?: string | undefined;
  /** Westgard rules to apply; they need the mean and SD. */
  westgardRules?: string[] | undefined;
  /** Minutes that make one run, for R-4s (A-38). */
  runMinutes?: string | undefined;
}

export interface ParsedQcRange {
  instrumentId: string;
  localTestCode: string;
  controlLot: string | null;
  controlName: string | null;
  low: string;
  high: string;
  units: string;
  reference: string;
  targetMean: string | null;
  targetSd: string | null;
  westgardRules: WestgardRule[];
  runMinutes: number | null;
}

export function parseQcRange(i: QcRangeInput): { ok: true; value: ParsedQcRange } | { ok: false; issues: string[] } {
  const issues: string[] = [];
  const low = i.low.trim();
  const high = i.high.trim();
  const lot = i.controlLot.trim();
  const name = i.controlName.trim();
  if (!i.instrumentId.trim()) issues.push('Choose the instrument.');
  if (!i.localTestCode.trim()) issues.push('Choose the test.');
  if (!lot && !name) issues.push('Enter the control lot, the control name, or both, exactly as the instrument sends them.');
  if (lot.length > 40 || name.length > 40) issues.push('Control lot and name: at most 40 characters each.');
  if (!isDecimal(low)) issues.push('The lowest acceptable value must be a number such as 4.1.');
  if (!isDecimal(high)) issues.push('The highest acceptable value must be a number such as 4.9.');
  if (isDecimal(low) && isDecimal(high) && compareDecimal(low, high) > 0) issues.push('The lowest acceptable value must not be above the highest.');
  if (!i.units.trim() || i.units.trim().length > 20) issues.push('Units: 1 to 20 characters, exactly as the instrument reports them.');
  if (i.reference.trim().length < 5 || i.reference.trim().length > 200) issues.push('Source: 5 to 200 characters, for example the control insert or the lab\'s QC plan and its version.');
  const w = parseWestgard(i.targetMean ?? '', i.targetSd ?? '', i.westgardRules ?? [], i.runMinutes ?? '');
  if (!w.ok) issues.push(...w.issues);
  if (issues.length || !w.ok) return { ok: false, issues };
  return { ok: true, value: { instrumentId: i.instrumentId.trim(), localTestCode: i.localTestCode.trim(), controlLot: lot || null, controlName: name || null, low, high, units: i.units.trim(), reference: i.reference.trim(), ...w.value } };
}

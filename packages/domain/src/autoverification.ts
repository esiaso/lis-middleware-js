import type { ResultValue } from '@lis/contracts';
import { compareDecimal, isDecimal } from './critical-limits.js';
import type { ResultAggregate, VersionKind, WorkflowResult } from './result-workflow.js';

/**
 * Autoverification (08 §12, A-6, A-19): a per-test rule the lab director
 * turns on only after the lab's own validation. Off for every test until
 * then. A result passes only when every check passes; any doubt fails it
 * and leaves it for a person. The middleware ships with no rules.
 */
export interface AutoverifyRule {
  id: string;
  /** Inclusive: values from low to high, in these exact units, may pass. */
  low: string;
  high: string;
  units: string;
}

export interface AutoverifyInput {
  kind: VersionKind;
  value: ResultValue;
  units: string | null | undefined;
  abnormalFlags: string[];
  /** Instrument-specific flags from the message (07 §5). */
  instrumentFlags: string[];
  editedOnInstrument: boolean;
  criticalFlag: string | null;
  /** Instrument cleared for clinical use (verification gate). */
  instrumentCleared: boolean;
}

export interface AutoverifyCheck {
  check: string;
  ok: boolean;
  detail: string;
}

export interface AutoverifyOutcome {
  passed: boolean;
  checks: AutoverifyCheck[];
}

export const AUTOVERIFY_ACTOR = 'system:autoverify';

/** Every check runs, so a reviewer sees all the reasons a result was held, not only the first. */
export function evaluateAutoverification(rule: AutoverifyRule, i: AutoverifyInput): AutoverifyOutcome {
  const checks: AutoverifyCheck[] = [];
  const add = (check: string, ok: boolean, detail: string) => checks.push({ check, ok, detail });
  add('first value', i.kind === 'initial', i.kind === 'initial' ? 'first value from the instrument' : `a ${i.kind} value is always left for a person`);
  add('instrument cleared', i.instrumentCleared, i.instrumentCleared ? 'instrument cleared for clinical use' : 'instrument not cleared for clinical use');
  const numeric = i.value.kind === 'numeric';
  add('numeric value', numeric, numeric ? 'plain number' : `a ${i.value.kind} value is left for a person`);
  const units = (i.units ?? '').trim();
  add('units', units === rule.units.trim(), units === rule.units.trim() ? `in ${rule.units}` : `in ${units || 'no units'}, the rule is for ${rule.units}`);
  if (numeric && i.value.kind === 'numeric') {
    const v = i.value.value;
    const inside = compareDecimal(v, rule.low) >= 0 && compareDecimal(v, rule.high) <= 0;
    add('range', inside, inside ? `${v} within ${rule.low} to ${rule.high}` : `${v} outside ${rule.low} to ${rule.high}`);
  } else add('range', false, 'no number to compare');
  add('abnormal flags', i.abnormalFlags.length === 0, i.abnormalFlags.length ? `flagged ${i.abnormalFlags.join(' ')}` : 'none');
  add('instrument flags', i.instrumentFlags.length === 0, i.instrumentFlags.length ? `instrument flags ${i.instrumentFlags.join(' ')}` : 'none');
  add('not edited', !i.editedOnInstrument, i.editedOnInstrument ? 'edited on the instrument' : 'not edited');
  add('not critical', !i.criticalFlag, i.criticalFlag ? `critical check: ${i.criticalFlag}` : 'not critical');
  return { passed: checks.every((c) => c.ok), checks };
}

export interface AutoverifyRuleInput {
  localTestCode: string;
  low: string;
  high: string;
  units: string;
  reference: string;
  qcAcknowledged: boolean;
}

/** Check a rule typed into the form. Both bounds are required: an open-ended range would pass anything above or below. */
export function parseAutoverifyRule(i: AutoverifyRuleInput): { ok: true; value: Omit<AutoverifyRuleInput, 'qcAcknowledged'> } | { ok: false; issues: string[] } {
  const issues: string[] = [];
  const low = i.low.trim();
  const high = i.high.trim();
  if (!i.localTestCode.trim()) issues.push('Choose the test.');
  if (!isDecimal(low)) issues.push('The lowest value must be a number such as 0.5.');
  if (!isDecimal(high)) issues.push('The highest value must be a number such as 4.5.');
  if (isDecimal(low) && isDecimal(high) && compareDecimal(low, high) > 0) issues.push('The lowest value must not be above the highest.');
  if (!i.units.trim() || i.units.trim().length > 20) issues.push('Units: 1 to 20 characters, exactly as the instrument reports them.');
  if (i.reference.trim().length < 5 || i.reference.trim().length > 200) issues.push('Validation report: 5 to 200 characters naming the report and its version.');
  if (!i.qcAcknowledged) issues.push('Confirm how QC is covered: the middleware does not check QC.');
  if (issues.length) return { ok: false, issues };
  return { ok: true, value: { localTestCode: i.localTestCode.trim(), low, high, units: i.units.trim(), reference: i.reference.trim() } };
}

/**
 * Approve a result that passed autoverification. Only the first value of a
 * result nobody has touched yet: a repeat, a review or a correction means a
 * person is already involved. Release stays with a person.
 */
export function autoverifyResult(a: ResultAggregate): WorkflowResult {
  if (a.status !== 'received') return { ok: false, error: { code: 'INVALID_STATE', detail: `only a received result can be autoverified (is ${a.status})` } };
  if (a.versions.length !== 1 || a.selectedVersionNo !== 1) return { ok: false, error: { code: 'INVALID_STATE', detail: 'only the first value of a result can be autoverified' } };
  return { ok: true, value: { ...a, status: 'approved', reviewedBy: AUTOVERIFY_ACTOR, approvedBy: AUTOVERIFY_ACTOR } };
}

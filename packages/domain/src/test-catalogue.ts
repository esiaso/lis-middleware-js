import type { ResultValue } from '@lis/contracts';
import { canonicalDecimal } from './value-parser.js';

/**
 * The lab's own test catalogue (design: "Test catalogue and LOINC", "Manual
 * tests"). Pure rules: what a catalogue entry may hold, and how a value typed
 * on the manual worksheet becomes a result value. No codes are shipped; every
 * entry, LOINC code and answer list comes from the lab.
 */

export const RESULT_TYPES = ['NUMERIC', 'ORDINAL', 'NOMINAL', 'TEXT', 'PANEL'] as const;
export type CatalogueResultType = (typeof RESULT_TYPES)[number];
export const PERFORMED_BY = ['INSTRUMENT', 'MANUAL'] as const;
export type PerformedBy = (typeof PERFORMED_BY)[number];
/** What entering a manual result needs from QC for the lot used (A-33). */
export const QC_RULES = ['NONE', 'WARN', 'BLOCK'] as const;
export type QcRule = (typeof QC_RULES)[number];

export interface CatalogueAnswer {
  /** Short code stored on the result, such as NEG or 2+. */
  code: string;
  /** Words shown on screens and sent to the HMIS. */
  display: string;
  /** This answer is outside normal (for example a positive malaria test). */
  abnormal?: boolean;
  /**
   * The lab director has made this answer critical (A-36): like a value past a
   * critical limit, approval waits until a call with read-back is recorded.
   * A critical answer is always abnormal too.
   */
  critical?: boolean;
  /** LOINC answer code (LA...), when the lab has chosen one. */
  loinc?: string;
}

export interface CatalogueDefinition {
  localCode: string;
  name: string;
  section: string;
  loincCode?: string;
  loincDisplay?: string;
  shaCode?: string;
  specimenType?: string;
  performedBy: PerformedBy;
  resultType: CatalogueResultType;
  answers: CatalogueAnswer[];
  unit?: string;
  decimals?: number;
  /** For a PANEL: its component tests' local codes, in report order. */
  components?: string[];
  /** For a manual test or panel: WARN or BLOCK entry without a passing control for the lot; absent means none (A-33). */
  qcRule?: Exclude<QcRule, 'NONE'>;
  /** How long a passing control counts, in hours; absent means for the whole lot. */
  qcValidHours?: number;
}

/** What a person types on the catalogue form, as text. */
export interface CatalogueForm {
  localCode: string;
  name: string;
  section: string;
  loincCode: string;
  loincDisplay: string;
  shaCode: string;
  specimenType: string;
  performedBy: string;
  resultType: string;
  /** One answer per line: "code | display", optionally "| abnormal" (or "| critical") and "| LA code". */
  answers: string;
  unit: string;
  decimals: string;
  /** For a panel: component local codes, one per line or separated by commas. */
  components?: string;
  /** NONE, WARN or BLOCK; empty means NONE. */
  qcRule?: string;
  /** Whole hours, or empty for the whole lot. */
  qcValidHours?: string;
}

const CODE = /^[A-Z0-9][A-Z0-9._-]{0,19}$/;
const LOINC = /^\d{1,7}-\d$/;
const LOINC_ANSWER = /^LA\d{1,8}-\d$/;
const ANSWER_CODE = /^[A-Za-z0-9+._-]{1,20}$/;

/** LOINC term check digit (mod 10, as LOINC publishes it), so a mistyped code is caught at entry. */
export function loincCheckDigitOk(code: string): boolean {
  const m = /^(\d+)-(\d)$/.exec(code);
  if (!m) return false;
  const digits = m[1]!;
  // Double every other digit from the right, starting with the rightmost.
  let doubled = '';
  let kept = 0;
  for (let i = digits.length - 1, k = 0; i >= 0; i--, k++) {
    const d = Number(digits[i]);
    if (k % 2 === 0) doubled = String(d * 2) + doubled;
    else kept += d;
  }
  const sum = [...doubled].reduce((s, c) => s + Number(c), 0) + kept;
  return (10 - (sum % 10)) % 10 === Number(m[2]);
}

export function parseAnswers(text: string): { answers: CatalogueAnswer[]; issues: string[] } {
  const answers: CatalogueAnswer[] = [];
  const issues: string[] = [];
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const [i, line] of lines.entries()) {
    const parts = line.split('|').map((p) => p.trim());
    const [code = '', display = '', ...rest] = parts;
    const n = i + 1;
    if (!ANSWER_CODE.test(code)) {
      issues.push(`Answer ${n}: the code is 1 to 20 letters, digits or + . _ - (such as NEG or 2+).`);
      continue;
    }
    if (display.length < 1 || display.length > 80) {
      issues.push(`Answer ${n}: give the words to show, up to 80 characters, after a | sign.`);
      continue;
    }
    const a: CatalogueAnswer = { code, display };
    for (const r of rest) {
      if (r.toLowerCase() === 'abnormal') a.abnormal = true;
      else if (r.toLowerCase() === 'critical') a.critical = a.abnormal = true;
      // Answer codes are only checked for shape: their check digit is not computed like a term's.
      else if (LOINC_ANSWER.test(r)) a.loinc = r;
      else if (r) issues.push(`Answer ${n}: "${r}" is not "abnormal", "critical" or a LOINC answer code (LA...).`);
    }
    if (answers.some((x) => x.code.toUpperCase() === code.toUpperCase())) issues.push(`Answer ${n}: the code ${code} is used twice.`);
    answers.push(a);
  }
  return { answers, issues };
}

export function parseCatalogueForm(f: CatalogueForm): { ok: true; value: CatalogueDefinition } | { ok: false; issues: string[] } {
  const issues: string[] = [];
  const localCode = f.localCode.trim().toUpperCase();
  if (!CODE.test(localCode)) issues.push('The local code is 1 to 20 capital letters, digits, dots, dashes or underscores, such as TSH or MAL-RDT.');
  const name = f.name.trim();
  if (name.length < 2 || name.length > 120) issues.push('The name is 2 to 120 characters.');
  const section = f.section.trim();
  if (section.length < 2 || section.length > 40) issues.push('Name the bench, such as Parasitology or Urinalysis.');
  const loincCode = f.loincCode.trim();
  if (loincCode && !LOINC.test(loincCode)) issues.push('A LOINC code looks like 3016-3.');
  else if (loincCode && !loincCheckDigitOk(loincCode)) issues.push(`${loincCode} fails the LOINC check digit. Check it against the LOINC release the HMIS uses.`);
  const loincDisplay = f.loincDisplay.trim();
  if (loincDisplay.length > 255) issues.push('The LOINC name is at most 255 characters.');
  if (loincDisplay && !loincCode) issues.push('Give the LOINC code for that LOINC name.');
  const shaCode = f.shaCode.trim();
  if (shaCode.length > 40) issues.push('The SHA code is at most 40 characters.');
  const specimenType = f.specimenType.trim();
  if (specimenType.length > 40) issues.push('The specimen type is at most 40 characters.');
  const performedBy = f.performedBy as PerformedBy;
  if (!PERFORMED_BY.includes(performedBy)) issues.push('Say whether an instrument or a person performs the test.');
  const resultType = f.resultType as CatalogueResultType;
  if (!RESULT_TYPES.includes(resultType)) issues.push('Pick a result type.');
  const { answers, issues: answerIssues } = parseAnswers(f.answers);
  const coded = resultType === 'ORDINAL' || resultType === 'NOMINAL';
  if (coded) {
    issues.push(...answerIssues);
    if (answers.length < 2 && answerIssues.length === 0) issues.push('A choice result needs at least two answers, one per line.');
  } else if (f.answers.trim()) issues.push('Only ordinal and nominal results have an answer list.');
  const components = (f.components ?? '').split(/[\s,]+/).map((c) => c.trim().toUpperCase()).filter(Boolean);
  if (resultType === 'PANEL') {
    if (components.length < 2) issues.push('A panel lists at least two component tests by their local codes.');
    const bad = components.filter((c) => !CODE.test(c));
    if (bad.length) issues.push(`Not a local code: ${bad.join(', ')}.`);
    const twice = components.filter((c, i) => components.indexOf(c) !== i);
    if (twice.length) issues.push(`Listed twice: ${[...new Set(twice)].join(', ')}.`);
    if (components.includes(localCode)) issues.push('A panel cannot list itself.');
  } else if (components.length) issues.push('Only a panel has component tests.');
  const unit = f.unit.trim();
  if (unit.length > 40) issues.push('The unit is at most 40 characters.');
  if (unit && resultType !== 'NUMERIC') issues.push('Only a numeric result has a unit.');
  let decimals: number | undefined;
  if (f.decimals.trim()) {
    if (!/^\d$/.test(f.decimals.trim()) || Number(f.decimals) > 6) issues.push('Decimals is a whole number from 0 to 6.');
    else decimals = Number(f.decimals);
    if (resultType !== 'NUMERIC') issues.push('Only a numeric result has decimals.');
  }
  const qcRule = ((f.qcRule ?? '').trim() || 'NONE') as QcRule;
  if (!QC_RULES.includes(qcRule)) issues.push('Pick what QC the test needs: none, warn or block.');
  else if (qcRule !== 'NONE' && performedBy === 'INSTRUMENT') issues.push('Instrument QC is set on the QC pages; the QC rule here is for tests read by a person.');
  let qcValidHours: number | undefined;
  const hoursText = (f.qcValidHours ?? '').trim();
  if (hoursText) {
    if (!/^\d{1,4}$/.test(hoursText) || Number(hoursText) < 1 || Number(hoursText) > 8760) issues.push('QC counts for 1 to 8760 hours, or leave it empty for the whole lot.');
    else qcValidHours = Number(hoursText);
    if (qcRule === 'NONE') issues.push('Set how long QC counts only when the test needs QC.');
  }
  if (issues.length) return { ok: false, issues };
  return {
    ok: true,
    value: {
      localCode,
      name,
      section,
      ...(loincCode ? { loincCode } : {}),
      ...(loincDisplay ? { loincDisplay } : {}),
      ...(shaCode ? { shaCode } : {}),
      ...(specimenType ? { specimenType } : {}),
      performedBy,
      resultType,
      answers: coded ? answers : [],
      ...(unit ? { unit } : {}),
      ...(decimals !== undefined ? { decimals } : {}),
      ...(resultType === 'PANEL' ? { components } : {}),
      ...(qcRule !== 'NONE' ? { qcRule } : {}),
      ...(qcValidHours !== undefined ? { qcValidHours } : {}),
    },
  };
}

/** The answers back as the form's text, for editing a new version. */
export const answersText = (answers: CatalogueAnswer[]): string =>
  answers.map((a) => [a.code, a.display, ...(a.critical ? ['critical'] : a.abnormal ? ['abnormal'] : []), ...(a.loinc ? [a.loinc] : [])].join(' | ')).join('\n');

export type ManualValue = { ok: true; value: ResultValue; units?: string; abnormalFlags: string[] } | { ok: false; issue: string };

/**
 * A value typed on the worksheet, checked against the catalogue entry. Nothing
 * is assumed: an empty field is an error, never a normal result.
 */
export function readManualValue(def: CatalogueDefinition, raw: string): ManualValue {
  const s = raw.trim();
  if (!s) return { ok: false, issue: 'Enter a result. An empty field is never taken as normal.' };
  switch (def.resultType) {
    case 'NUMERIC': {
      const cen = /^(<=|>=|<|>)\s*(.+)$/.exec(s);
      const num = canonicalDecimal(cen ? cen[2]!.trim() : s);
      if (!num) return { ok: false, issue: `${s} is not a number. Use digits and a decimal point, with < or > in front if needed.` };
      if (def.decimals !== undefined && num.scale > def.decimals) {
        return { ok: false, issue: `${def.name} is reported with ${def.decimals === 0 ? 'no decimals' : `at most ${def.decimals} decimal${def.decimals === 1 ? '' : 's'}`}.` };
      }
      const units = def.unit ? { units: def.unit } : {};
      if (cen) return { ok: true, value: { kind: 'censored', comparator: cen[1] as '<' | '<=' | '>' | '>=', limit: num.value }, abnormalFlags: [], ...units };
      return { ok: true, value: { kind: 'numeric', value: num.value, scale: num.scale }, abnormalFlags: [], ...units };
    }
    case 'ORDINAL':
    case 'NOMINAL': {
      const a = def.answers.find((x) => x.code === s);
      if (!a) return { ok: false, issue: `Pick one of the answers for ${def.name}.` };
      return { ok: true, value: { kind: 'qualitative', code: a.code }, abnormalFlags: a.abnormal ? ['A'] : [] };
    }
    case 'PANEL':
      return { ok: false, issue: `${def.name} is a panel: enter each of its tests.` };
    case 'TEXT':
      if (s.length > 4000) return { ok: false, issue: 'A text result is at most 4000 characters.' };
      return { ok: true, value: { kind: 'text', text: s }, abnormalFlags: [] };
  }
}

/** A control run as typed on the QC form. */
export interface ManualQcForm {
  control: string;
  expected: string;
  observed: string;
  /** PASS or FAIL, said by the person; only for tests without an answer list. */
  outcome?: string;
}

export type ManualQcJudgement = { ok: true; control: string; expected: string; observed: string; outcome: 'PASS' | 'FAIL' } | { ok: false; issues: string[] };

/**
 * One control run on a lot, checked against the catalogue entry. For a choice
 * test the expected and observed readings are answers and the outcome follows
 * from them; for a number, text or a whole panel the person says PASS or FAIL.
 */
export function judgeManualQc(def: CatalogueDefinition, f: ManualQcForm): ManualQcJudgement {
  const issues: string[] = [];
  const control = f.control.trim();
  const expected = f.expected.trim();
  const observed = f.observed.trim();
  if (control.length < 1 || control.length > 60) issues.push('Name the control, such as "positive control" or "known positive slide", in up to 60 characters.');
  if (!expected) issues.push('Say what the control should read.');
  if (!observed) issues.push('Say what the control read. An empty field is never taken as a pass.');
  if (expected.length > 200 || observed.length > 200) issues.push('The expected and observed readings are at most 200 characters each.');
  const coded = def.resultType === 'ORDINAL' || def.resultType === 'NOMINAL';
  if (coded) {
    for (const [what, v] of [['expected', expected], ['observed', observed]] as const) {
      if (v && !def.answers.some((a) => a.code === v)) issues.push(`Pick the ${what} reading from the answers for ${def.name}.`);
    }
  }
  const said = (f.outcome ?? '').trim().toUpperCase();
  if (!coded && said !== 'PASS' && said !== 'FAIL') issues.push('Say whether the control passed or failed.');
  if (issues.length) return { ok: false, issues };
  const outcome = coded ? (expected === observed ? 'PASS' : 'FAIL') : (said as 'PASS' | 'FAIL');
  return { ok: true, control, expected, observed, outcome };
}

export interface ManualQcRun {
  control: string;
  outcome: 'PASS' | 'FAIL';
  at: Date;
  lotExpiry: Date | null;
}

export type ManualQcStatus = 'pass' | 'failed' | 'missing' | 'expired';

/**
 * Whether a lot may be used now: the latest run of each control within the
 * window must have passed, and the lot must not be past its expiry date. With
 * no window, every run on the lot counts. A failure stays until that control
 * passes again.
 */
export function manualQcStatus(runs: ManualQcRun[], now: Date, validHours?: number): { status: ManualQcStatus; failed: string[]; lastPass?: Date } {
  const expiry = runs.map((r) => r.lotExpiry).filter((d): d is Date => d !== null).sort((a, b) => b.getTime() - a.getTime())[0];
  // The expiry date is the last day the lot may be used.
  if (expiry && now.getTime() >= expiry.getTime() + 24 * 3600 * 1000) return { status: 'expired', failed: [] };
  const from = validHours === undefined ? -Infinity : now.getTime() - validHours * 3600 * 1000;
  const latest = new Map<string, ManualQcRun>();
  for (const r of runs) {
    if (r.at.getTime() < from || r.at.getTime() > now.getTime()) continue;
    const key = r.control.toLowerCase();
    const seen = latest.get(key);
    if (!seen || r.at.getTime() >= seen.at.getTime()) latest.set(key, r);
  }
  if (latest.size === 0) return { status: 'missing', failed: [] };
  const failed = [...latest.values()].filter((r) => r.outcome === 'FAIL').map((r) => r.control);
  if (failed.length) return { status: 'failed', failed };
  const lastPass = new Date(Math.max(...[...latest.values()].map((r) => r.at.getTime())));
  return { status: 'pass', failed: [], lastPass };
}

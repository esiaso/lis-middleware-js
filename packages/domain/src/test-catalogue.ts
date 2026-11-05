import type { ResultValue } from '@lis/contracts';
import { canonicalDecimal } from './value-parser.js';

/**
 * The lab's own test catalogue (design: "Test catalogue and LOINC", "Manual
 * tests"). Pure rules: what a catalogue entry may hold, and how a value typed
 * on the manual worksheet becomes a result value. No codes are shipped; every
 * entry, LOINC code and answer list comes from the lab.
 */

export const RESULT_TYPES = ['NUMERIC', 'ORDINAL', 'NOMINAL', 'TEXT'] as const;
export type CatalogueResultType = (typeof RESULT_TYPES)[number];
export const PERFORMED_BY = ['INSTRUMENT', 'MANUAL'] as const;
export type PerformedBy = (typeof PERFORMED_BY)[number];

export interface CatalogueAnswer {
  /** Short code stored on the result, such as NEG or 2+. */
  code: string;
  /** Words shown on screens and sent to the HMIS. */
  display: string;
  /** This answer is outside normal (for example a positive malaria test). */
  abnormal?: boolean;
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
  /** One answer per line: "code | display", optionally "| abnormal" and "| LA code". */
  answers: string;
  unit: string;
  decimals: string;
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
      // Answer codes are only checked for shape: their check digit is not computed like a term's.
      else if (LOINC_ANSWER.test(r)) a.loinc = r;
      else if (r) issues.push(`Answer ${n}: "${r}" is neither "abnormal" nor a LOINC answer code (LA...).`);
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
  const unit = f.unit.trim();
  if (unit.length > 40) issues.push('The unit is at most 40 characters.');
  if (unit && resultType !== 'NUMERIC') issues.push('Only a numeric result has a unit.');
  let decimals: number | undefined;
  if (f.decimals.trim()) {
    if (!/^\d$/.test(f.decimals.trim()) || Number(f.decimals) > 6) issues.push('Decimals is a whole number from 0 to 6.');
    else decimals = Number(f.decimals);
    if (resultType !== 'NUMERIC') issues.push('Only a numeric result has decimals.');
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
    },
  };
}

/** The answers back as the form's text, for editing a new version. */
export const answersText = (answers: CatalogueAnswer[]): string =>
  answers.map((a) => [a.code, a.display, ...(a.abnormal ? ['abnormal'] : []), ...(a.loinc ? [a.loinc] : [])].join(' | ')).join('\n');

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
    case 'TEXT':
      if (s.length > 4000) return { ok: false, issue: 'A text result is at most 4000 characters.' };
      return { ok: true, value: { kind: 'text', text: s }, abnormalFlags: [] };
  }
}

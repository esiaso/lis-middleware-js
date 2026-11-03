import type { Comparator, ResultValue } from '@lis/contracts';

const NUMBER = /^([+-]?)(\d*)(?:\.(\d*))?$/;
const CENSORED = /^(<=|>=|<|>)\s*(.+)$/;

/**
 * Canonicalise a numeric string WITHOUT converting it to a JS number.
 * Keeps the reported number of decimal places (scale), because "1.50" and
 * "1.5" carry different precision. Strips redundant leading zeros and a
 * leading "+". Returns null for anything that is not a plain decimal.
 */
export function canonicalDecimal(text: string): { value: string; scale: number } | null {
  const m = NUMBER.exec(text);
  if (!m) return null;
  const sign = m[1] === '-' ? '-' : '';
  const intDigits = m[2] ?? '';
  const fracDigits = m[3];
  if (intDigits === '' && (fracDigits === undefined || fracDigits === '')) return null;
  const intPart = intDigits.replace(/^0+(?=\d)/, '') || '0';
  const scale = fracDigits?.length ?? 0;
  const body = scale > 0 ? `${intPart}.${fracDigits}` : intPart;
  const isZero = /^0(\.0*)?$/.test(body);
  return { value: `${isZero ? '' : sign}${body}`, scale };
}

export interface NumericParseOptions {
  /** Treat values made only of '*' and '.' as masked (Mindray examples show "***.**"). */
  maskedPattern?: RegExp;
}

/**
 * Parse an instrument numeric field into a ResultValue.
 *
 * Handles:
 *  - plain decimals ("0.310", "+1.25", "-1")
 *  - censored values ("<0.01", ">1000", "<=5") as reported on measuring-range errors [e411 HIM E-16]
 *  - empty or all-space fields ("seven spaces if no result" [e411 HIM E-16]) as absent
 *  - masked placeholders ("***.*") as absent/masked
 *  - anything else as text, so nothing is silently dropped
 */
export function parseNumericField(raw: string, opts: NumericParseOptions = {}): ResultValue {
  const text = raw.trim();
  if (text === '') return { kind: 'absent', reason: 'no-result' };
  const masked = opts.maskedPattern ?? /^[*.]+$/;
  if (masked.test(text)) return { kind: 'absent', reason: 'masked' };

  const plain = canonicalDecimal(text);
  if (plain) return { kind: 'numeric', value: plain.value, scale: plain.scale };

  const c = CENSORED.exec(text);
  if (c) {
    const limit = canonicalDecimal((c[2] ?? '').trim());
    if (limit) return { kind: 'censored', comparator: c[1] as Comparator, limit: limit.value };
  }
  return { kind: 'text', text };
}

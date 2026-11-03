/**
 * ASTM E1394 record layer: records → fields → repeats → components.
 *
 * Delimiters are taken from the H record (characters 2-5), never assumed
 * [e411 HIM E-4]: field, repeat, component, escape. Escape sequences
 * &F& &S& &R& &E& are decoded; any other escape sequence is treated as
 * null, as the manual specifies [e411 HIM E-4].
 */

export interface Delimiters {
  field: string;
  repeat: string;
  component: string;
  escape: string;
}

export const DEFAULT_DELIMITERS: Delimiters = { field: '|', repeat: '\\', component: '^', escape: '&' };

export interface AstmRecord {
  /** Record type letter, upper-cased ("H", "P", "O", "R", "C", "Q", "L", "M"). */
  type: string;
  /** Fields as raw (still escaped) strings. fields[0] is the type, so fields[n] is ASTM position n+1. */
  fields: string[];
  /** The record text as received, without the terminating CR. */
  raw: string;
}

export interface AstmMessage {
  delimiters: Delimiters;
  records: AstmRecord[];
  /** True if the message starts with H and ends with L. */
  complete: boolean;
}

export class AstmParseError extends Error {
  constructor(message: string, readonly detail?: string) {
    super(message);
    this.name = 'AstmParseError';
  }
}

export function delimitersFromHeader(headerRecord: string): Delimiters {
  if (!/^[Hh]/.test(headerRecord) || headerRecord.length < 5) {
    throw new AstmParseError('header record missing or too short');
  }
  const [field, repeat, component, escape] = [headerRecord[1], headerRecord[2], headerRecord[3], headerRecord[4]] as [
    string,
    string,
    string,
    string,
  ];
  if (new Set([field, repeat, component, escape]).size !== 4) {
    throw new AstmParseError('header delimiters are not distinct', headerRecord.slice(0, 5));
  }
  return { field, repeat, component, escape };
}

/**
 * Split a transfer's text into ASTM messages (H … L). Records are CR-terminated.
 * Text before the first H is reported as an error rather than silently dropped.
 */
export function parseTransfer(text: string): { messages: AstmMessage[]; errors: string[] } {
  const errors: string[] = [];
  const lines = text.split('\r').filter((l) => l.length > 0);
  const messages: AstmMessage[] = [];
  let current: AstmMessage | null = null;

  for (const line of lines) {
    const type = line[0]?.toUpperCase() ?? '';
    if (type === 'H') {
      if (current) {
        errors.push('header before previous message terminated');
        messages.push(current);
      }
      try {
        current = { delimiters: delimitersFromHeader(line), records: [], complete: false };
      } catch (e) {
        errors.push((e as Error).message);
        current = null;
        continue;
      }
    }
    if (!current) {
      errors.push(`record outside message: ${line.slice(0, 20)}`);
      continue;
    }
    current.records.push(splitRecord(line, current.delimiters));
    if (type === 'L') {
      current.complete = current.records[0]?.type === 'H';
      messages.push(current);
      current = null;
    }
  }
  if (current) {
    errors.push('message not terminated by L record');
    messages.push(current);
  }
  return { messages, errors };
}

export function splitRecord(line: string, d: Delimiters): AstmRecord {
  const type = (line[0] ?? '').toUpperCase();
  if (type === 'H') {
    // H|\^&|… : the delimiter definition is field 2 and must not be split.
    const rest = line.slice(5); // after "H|\^&"
    const fields = ['H', line.slice(2, 5), ...rest.split(d.field).slice(1)];
    return { type, fields, raw: line };
  }
  return { type, fields: line.split(d.field), raw: line };
}

/** Field at ASTM position `pos` (1-based, position 1 is the record type). */
export function field(rec: AstmRecord, pos: number): string {
  return rec.fields[pos - 1] ?? '';
}

export function repeats(value: string, d: Delimiters): string[] {
  return value === '' ? [] : value.split(d.repeat);
}

export function components(value: string, d: Delimiters): string[] {
  return value.split(d.component);
}

/** Decode escape sequences in a single component value [e411 HIM E-4]. */
export function unescape(value: string, d: Delimiters): string {
  if (!value.includes(d.escape)) return value;
  const map: Record<string, string> = { F: d.field, S: d.component, R: d.repeat, E: d.escape };
  let out = '';
  let i = 0;
  while (i < value.length) {
    const ch = value[i] as string;
    if (ch !== d.escape) {
      out += ch;
      i++;
      continue;
    }
    const end = value.indexOf(d.escape, i + 1);
    if (end === -1) {
      out += value.slice(i); // unterminated: keep literally
      break;
    }
    const code = value.slice(i + 1, end);
    out += map[code] ?? ''; // unknown escape → null [e411 HIM E-4]
    i = end + 1;
  }
  return out;
}

/** Escape a value for sending. */
export function escapeValue(value: string, d: Delimiters): string {
  let out = '';
  for (const ch of value) {
    if (ch === d.escape) out += `${d.escape}E${d.escape}`;
    else if (ch === d.field) out += `${d.escape}F${d.escape}`;
    else if (ch === d.component) out += `${d.escape}S${d.escape}`;
    else if (ch === d.repeat) out += `${d.escape}R${d.escape}`;
    else out += ch;
  }
  return out;
}

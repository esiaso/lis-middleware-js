/**
 * Minimal HL7 v2 parser/encoder. Delimiters come from MSH-1/MSH-2.
 * Escape sequences \F\ \S\ \T\ \R\ \E\ \.br\ are decoded [Mindray HL7 §3].
 */

export interface Hl7Delimiters {
  field: string;
  component: string;
  repetition: string;
  escape: string;
  subcomponent: string;
}

export const DEFAULT_HL7_DELIMITERS: Hl7Delimiters = {
  field: '|',
  component: '^',
  repetition: '~',
  escape: '\\',
  subcomponent: '&',
};

export interface Hl7Segment {
  name: string;
  /**
   * fields[n] is HL7 field n of the segment (fields[0] is the segment name).
   * For MSH, fields[1] is the field separator and fields[2] the encoding characters,
   * so MSH-n is fields[n] exactly as in the standard.
   */
  fields: string[];
}

export interface Hl7Message {
  delimiters: Hl7Delimiters;
  segments: Hl7Segment[];
}

export class Hl7ParseError extends Error {
  constructor(
    message: string,
    /** Suggested MSA-6 status code where one applies [Mindray HL7 4.3.2 Table 4-3]. */
    readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'Hl7ParseError';
  }
}

export function parseHl7(text: string): Hl7Message {
  // Segments end with CR; tolerate LF and CRLF from non-conforming senders.
  const lines = text.split(/\r\n|\r|\n/).filter((l) => l.length > 0);
  const first = lines[0];
  if (!first || !first.startsWith('MSH') || first.length < 8) throw new Hl7ParseError('message does not start with MSH', 100);
  const d: Hl7Delimiters = {
    field: first[3] as string,
    component: first[4] as string,
    repetition: first[5] as string,
    escape: first[6] as string,
    subcomponent: first[7] as string,
  };
  if (new Set(Object.values(d)).size !== 5) throw new Hl7ParseError('MSH delimiters are not distinct', 102);
  const segments = lines.map((line) => {
    const parts = line.split(d.field);
    const name = parts[0] ?? '';
    if (!/^[A-Z][A-Z0-9]{2}$/.test(name)) throw new Hl7ParseError(`invalid segment name "${name.slice(0, 10)}"`, 100);
    if (name === 'MSH') {
      // MSH-1 is the field separator itself; MSH-2 the encoding characters.
      return { name, fields: ['MSH', d.field, ...parts.slice(1)] };
    }
    return { name, fields: parts };
  });
  return { delimiters: d, segments };
}

export function segments(msg: Hl7Message, name: string): Hl7Segment[] {
  return msg.segments.filter((s) => s.name === name);
}

export function firstSegment(msg: Hl7Message, name: string): Hl7Segment | undefined {
  return msg.segments.find((s) => s.name === name);
}

/** Raw (escaped) field value. */
export function rawField(seg: Hl7Segment | undefined, n: number): string {
  return seg?.fields[n] ?? '';
}

/** Component `c` (1-based) of field `n`, first repetition, unescaped. */
export function comp(msg: Hl7Message, seg: Hl7Segment | undefined, n: number, c = 1): string {
  const rep = rawField(seg, n).split(msg.delimiters.repetition)[0] ?? '';
  return hl7Unescape(rep.split(msg.delimiters.component)[c - 1] ?? '', msg.delimiters);
}

/** All repetitions of a field, unescaped as whole strings. */
export function repetitions(msg: Hl7Message, seg: Hl7Segment | undefined, n: number): string[] {
  const v = rawField(seg, n);
  return v === '' ? [] : v.split(msg.delimiters.repetition).map((r) => hl7Unescape(r, msg.delimiters));
}

export function hl7Unescape(value: string, d: Hl7Delimiters): string {
  if (!value.includes(d.escape)) return value;
  const map: Record<string, string> = {
    F: d.field,
    S: d.component,
    T: d.subcomponent,
    R: d.repetition,
    E: d.escape,
    '.br': '\r',
  };
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
      out += value.slice(i);
      break;
    }
    const code = value.slice(i + 1, end);
    out += map[code] ?? `${d.escape}${code}${d.escape}`; // unknown: keep as received
    i = end + 1;
  }
  return out;
}

export function hl7Escape(value: string, d: Hl7Delimiters = DEFAULT_HL7_DELIMITERS): string {
  let out = '';
  for (const ch of value) {
    if (ch === d.escape) out += `${d.escape}E${d.escape}`;
    else if (ch === d.field) out += `${d.escape}F${d.escape}`;
    else if (ch === d.component) out += `${d.escape}S${d.escape}`;
    else if (ch === d.subcomponent) out += `${d.escape}T${d.escape}`;
    else if (ch === d.repetition) out += `${d.escape}R${d.escape}`;
    else if (ch === '\r') out += `${d.escape}.br${d.escape}`;
    else out += ch;
  }
  return out;
}

/**
 * Encode segments. Each segment is a list of already-escaped field strings,
 * starting with the segment name. For MSH pass ['MSH', encodingChars, MSH-3, ...].
 */
export function encodeHl7(segs: string[][], d: Hl7Delimiters = DEFAULT_HL7_DELIMITERS): string {
  return segs
    .map((s) => {
      if (s[0] === 'MSH') return `MSH${d.field}${s.slice(1).join(d.field)}`;
      return s.join(d.field);
    })
    .map((s) => `${s}\r`)
    .join('');
}

/** HL7 TS "YYYYMMDDHHMMSS" in a given IANA zone, without offset (as the Mindray examples show). */
export function hl7Timestamp(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${get('year')}${get('month')}${get('day')}${get('hour')}${get('minute')}${get('second')}`;
}

import { DEFAULT_DELIMITERS, escapeValue } from '@lis/protocol-astm';
import { MAX_TESTS_PER_ORDER, type E411Options } from './options.js';
import type { E411Query } from './parse.js';

export interface E411OrderTest {
  /** Host test code as configured in the analyzer's Host Test Code table [e411 HIM B-5]. */
  hostTestCode: string;
  /** Dilution ratio: 1 (none), 2, 5, 10, 20, 50 or 100 [e411 HIM E-12, E-14]. */
  dilutionRatio?: 1 | 2 | 5 | 10 | 20 | 50 | 100;
}

export interface E411QueryAnswer {
  found: boolean;
  priority: 'routine' | 'stat';
  tests: E411OrderTest[];
  /** Specimen descriptor: 1 serum, 2 urine, 5 others [e411 HIM E-12]. Defaults from the query's sample type. */
  specimenDescriptor?: '1' | '2' | '5';
}

/** Elecsys® dilution factor codes by ratio [e411 HIM E-14, Table E-3]. */
const ELECSYS_DILUTION_FACTOR: Record<number, string> = { 1: '0', 2: '1', 5: '2', 10: '3', 20: '5', 50: '7', 100: '9' };

export class E411ReplyError extends Error {}

/**
 * Build the host's reply to a real-time order inquiry, records separated by CR.
 * The analyzer's sequence, carrier and position are echoed unchanged [e411 HIM F-2].
 */
export function buildE411QueryReply(query: E411Query, answer: E411QueryAnswer, opts: E411Options): Buffer {
  const d = DEFAULT_DELIMITERS;
  const tests = answer.found ? answer.tests : [];
  if (tests.length > MAX_TESTS_PER_ORDER) {
    throw new E411ReplyError(`${tests.length} tests exceed the ${MAX_TESTS_PER_ORDER}-test limit per order record`);
  }
  const seen = new Set<string>();
  for (const t of tests) {
    if (!/^\d{1,3}$/.test(t.hostTestCode)) throw new E411ReplyError(`host test code "${t.hostTestCode}" is not 1-3 digits`);
    // Multiple orders of the same test in one sample record are not allowed [e411 HIM E-13 note 6].
    if (seen.has(t.hostTestCode)) throw new E411ReplyError(`duplicate test ${t.hostTestCode}`);
    seen.add(t.hostTestCode);
  }

  const loc = query.location;
  const instSpecimen = [loc.sequenceNo, loc.carrierNo, loc.positionNo, '', loc.sampleType, loc.containerType]
    .map((v) => escapeValue(v, d))
    .join(d.component);
  const sampleId = escapeValue(query.sampleId, d);
  const priority = answer.priority === 'stat' ? 'S' : 'R';
  const records: string[] = [];

  if (opts.protocolType === 'cobas') {
    const testField = tests
      .map((t) => `^^^${t.hostTestCode}^${t.dilutionRatio && t.dilutionRatio !== 1 ? t.dilutionRatio : ''}`)
      .join(d.repeat);
    const descriptor = answer.specimenDescriptor ?? descriptorFromSampleType(loc.sampleType);
    records.push(`H|\\^&|||${opts.hostName}^1|||||cobas-e411|TSDWN^REPLY|P|1`);
    records.push('P|1');
    // Positions: 3 specimen ID, 4 instrument specimen ID, 5 tests, 6 priority, 12 action "A",
    // 16 specimen descriptor, 26 report type "O" [e411 HIM E-11 to E-13, F-3].
    records.push(oRecord({ 3: sampleId, 4: instSpecimen, 5: testField, 6: priority, 12: 'A', 16: descriptor, 26: 'O' }));
    records.push('L|1|N');
  } else {
    const testField = tests
      .map((t) => `^^^${t.hostTestCode}^${ELECSYS_DILUTION_FACTOR[t.dilutionRatio ?? 1] === '0' ? '' : ELECSYS_DILUTION_FACTOR[t.dilutionRatio ?? 1]}`)
      .join(d.repeat);
    records.push('H|\\^&||||||||||P||');
    records.push('P|1');
    // Action code "N" (new order), report type "Q" (reply) or "Z" (no order) [e411 HIM E-12, E-13, F-2].
    records.push(oRecord({ 3: sampleId, 4: instSpecimen, 5: testField, 6: priority, 12: 'N', 26: tests.length ? 'Q' : 'Z' }));
    records.push('L|1|');
  }
  return Buffer.from(records.map((r) => `${r}\r`).join(''), 'latin1');
}

function descriptorFromSampleType(sampleType: string): '1' | '2' | '5' {
  if (sampleType === 'S2') return '2';
  if (sampleType === 'S5') return '5';
  return '1';
}

/** Build an O record from a sparse map of ASTM positions (1-based). */
function oRecord(values: Record<number, string>): string {
  const max = Math.max(...Object.keys(values).map(Number));
  const fields: string[] = ['O', '1'];
  for (let pos = 3; pos <= max; pos++) fields.push(values[pos] ?? '');
  return fields.join('|');
}

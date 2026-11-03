import type { GenericAstmProfile, AstmLocator, NormalizedAnalyzerMessage, Observation } from '@lis/contracts';
import { parseNumericField } from '@lis/domain';
import { components, field, parseTransfer, repeats, unescape, type AstmRecord, type Delimiters } from '@lis/protocol-astm';
import { emptyMessage, mapStatus, type GenericParseContext } from './common.js';

export const GENERIC_ASTM_ADAPTER = 'generic-astm';

export interface GenericAstmResult {
  results: NormalizedAnalyzerMessage[];
  /** Host queries seen. Generic drivers never answer them; they are reported so the screen can say so. */
  unsupportedQueries: number;
  errors: string[];
}

/** Read one locator from a record; '' when absent. Repeats are not split here (first repeat is used). */
function read(rec: AstmRecord | undefined, loc: AstmLocator, d: Delimiters): string {
  if (!rec) return '';
  const first = repeats(field(rec, loc.field), d)[0] ?? '';
  return unescape(components(first, d)[loc.component - 1] ?? '', d);
}

/**
 * Parse one ASTM E1394 transfer with an administrator-supplied profile.
 * One normalised message per O record; R records attach to the preceding O;
 * C records after an R become instrument flags. Link-level handling
 * (E1381 framing, ACK after durable store) is the shared ASTM core.
 */
export function parseGenericAstmTransfer(bytes: Buffer, profile: GenericAstmProfile, ctx: GenericParseContext): GenericAstmResult {
  const text = profile.encoding === 'utf-8' ? new TextDecoder('utf-8', { fatal: true }).decode(bytes) : bytes.toString('latin1');
  const { messages, errors } = parseTransfer(text);
  const out: GenericAstmResult = { results: [], unsupportedQueries: 0, errors: [...errors] };

  for (const msg of messages) {
    if (!msg.complete) out.errors.push('incomplete message (no H … L)');
    const d = msg.delimiters;
    let patient: AstmRecord | undefined;
    let current: NormalizedAnalyzerMessage | null = null;
    let order: AstmRecord | undefined;
    let lastObs: Observation | null = null;

    const finishOrder = () => {
      if (current && order) classify(current, order, patient, profile, d);
    };

    for (const rec of msg.records) {
      switch (rec.type) {
        case 'P':
          finishOrder();
          patient = rec;
          current = null;
          order = undefined;
          lastObs = null;
          break;
        case 'O':
          finishOrder();
          order = rec;
          current = emptyMessage(GENERIC_ASTM_ADAPTER, ctx, profile.profileVersion);
          out.results.push(current);
          lastObs = null;
          break;
        case 'R':
          if (!current) {
            out.errors.push('result record without order record');
            break;
          }
          lastObs = toObservation(rec, profile, d);
          if (lastObs) current.observations.push(lastObs);
          else current.warnings.push({ code: 'R_WITHOUT_TEST_CODE', detail: rec.raw.slice(0, 60) });
          break;
        case 'C':
          if (lastObs) {
            const text = unescape(field(rec, 4), d).trim();
            if (text) lastObs.instrumentFlags.push({ code: 'COMMENT', text: text.slice(0, 200) });
          }
          break;
        case 'Q':
          out.unsupportedQueries++;
          break;
        default:
          break;
      }
    }
    finishOrder();
  }
  return out;
}

function classify(
  msg: NormalizedAnalyzerMessage,
  order: AstmRecord,
  patient: AstmRecord | undefined,
  profile: GenericAstmProfile,
  d: Delimiters,
): void {
  const recFor = (loc: AstmLocator) => (loc.record === 'P' ? patient : loc.record === 'O' ? order : undefined);
  const sampleId = read(recFor(profile.sampleId), profile.sampleId, d).trim();
  // QC rule on O/P checks every repeat (e.g. O-12 may carry several action codes).
  const qcLoc = profile.qcRule.at;
  const qcRec = recFor(qcLoc);
  const qcValues = qcRec
    ? repeats(field(qcRec, qcLoc.field), d).map((r) => unescape(components(r, d)[qcLoc.component - 1] ?? '', d).trim())
    : [];
  const isQc = qcValues.some((v) => profile.qcRule.equals.includes(v));
  msg.sampleClass = isQc ? 'qc' : 'patient';
  if (sampleId) msg.sampleId = sampleId;
  msg.sampleIdReadError = !isQc && sampleId === '';
  if (isQc) msg.qc = sampleId ? { controlName: sampleId } : {};
}

function toObservation(rec: AstmRecord, p: GenericAstmProfile, d: Delimiters): Observation | null {
  const code = read(rec, p.testCode, d).trim();
  if (!code) return null;
  const valueText = read(rec, p.value, d);
  const obs: Observation = {
    instrumentTestCode: code,
    originalValueText: field(rec, p.value.field),
    value: parseNumericField(valueText),
    abnormalFlags: repeats(field(rec, p.abnormalFlags.field), d)
      .map((f) => unescape(components(f, d)[p.abnormalFlags.component - 1] ?? '', d).trim())
      .filter(Boolean),
    instrumentFlags: [],
    resultStatus: mapStatus(read(rec, p.resultStatus, d), p.resultStatusMap),
    editedOnInstrument: false,
  };
  const units = read(rec, p.units, d).trim();
  if (units) obs.units = units;
  const ref = read(rec, p.referenceRange, d).trim();
  if (ref) obs.referenceRangeText = ref;
  const completed = read(rec, p.completedAt, d).trim();
  if (completed) obs.completedAtText = completed.slice(0, 26);
  return obs;
}

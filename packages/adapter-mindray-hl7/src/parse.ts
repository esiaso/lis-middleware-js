import type { NormalizedAnalyzerMessage, Observation, ResultValue } from '@lis/contracts';
import { parseNumericField } from '@lis/domain';
import {
  comp,
  firstSegment,
  parseHl7,
  rawField,
  repetitions,
  segments,
  type Hl7Message,
  type Hl7Segment,
} from '@lis/protocol-hl7v2';
import { ADAPTER_NAME, ADAPTER_VERSION } from './options.js';

export interface MindrayParseContext {
  rawMessageId: string;
  instrumentId: string;
  receivedAt: string;
}

export interface MindrayHeader {
  messageType: string; // e.g. "ORU^R01"
  controlId: string; // MSH-10
  processingId: string; // MSH-11: "P" sample / worklist, "Q" QC [Mindray 4.3.1]
  version: string; // MSH-12
  charset: string; // MSH-18
}

export type MindrayInbound =
  | { kind: 'result'; header: MindrayHeader; message: NormalizedAnalyzerMessage; hl7: Hl7Message }
  | { kind: 'worklist-query'; header: MindrayHeader; sampleIds: string[]; hl7: Hl7Message }
  | { kind: 'unsupported'; header: MindrayHeader; hl7: Hl7Message };

/** Recheck flag item [Mindray 5.8]. */
const RECHECK_FLAG_ID = '01006';
/** OBR-4 code for L-J QC results [Mindray 5.7]. */
const QC_RESULT_TYPE = '00003';

export function readHeader(msg: Hl7Message): MindrayHeader {
  const msh = firstSegment(msg, 'MSH');
  const type = rawField(msh, 9);
  return {
    messageType: type.split(msg.delimiters.component).slice(0, 2).join('^'),
    controlId: rawField(msh, 10),
    processingId: comp(msg, msh, 11),
    version: comp(msg, msh, 12),
    charset: rawField(msh, 18),
  };
}

/**
 * Decode and classify one MLLP payload. The payload is UTF-8 (MSH-18 "UNICODE")
 * [Mindray §1, 4.3.1]; invalid UTF-8 throws so the raw bytes can be quarantined.
 */
export function parseMindrayPayload(payload: Buffer, ctx: MindrayParseContext): MindrayInbound {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(payload);
  const hl7 = parseHl7(text);
  const header = readHeader(hl7);
  if (header.messageType === 'ORU^R01') {
    return { kind: 'result', header, message: normalizeOru(hl7, header, ctx), hl7 };
  }
  if (header.messageType === 'ORM^O01') {
    // ORC-3 carries the sample ID in the query [Mindray 4.3.7].
    const sampleIds = segments(hl7, 'ORC')
      .map((orc) => comp(hl7, orc, 3).trim())
      .filter((s) => s !== '');
    return { kind: 'worklist-query', header, sampleIds, hl7 };
  }
  return { kind: 'unsupported', header, hl7 };
}

function normalizeOru(hl7: Hl7Message, header: MindrayHeader, ctx: MindrayParseContext): NormalizedAnalyzerMessage {
  const pid = firstSegment(hl7, 'PID');
  const obr = firstSegment(hl7, 'OBR');
  const resultType = comp(hl7, obr, 4, 1);
  const isQc = header.processingId === 'Q' || resultType === QC_RESULT_TYPE;
  const sampleId = comp(hl7, obr, 3).trim(); // OBR-3: sample ID, or QC file no. [Mindray 4.3.5]
  const warnings: NormalizedAnalyzerMessage['warnings'] = [];
  if (segments(hl7, 'OBR').length > 1) {
    warnings.push({ code: 'MULTIPLE_OBR', detail: 'only the first OBR is used; not described in the document' });
  }

  const observations: Observation[] = [];
  let recheck = false;
  let binaryItems = 0;
  for (const obx of segments(hl7, 'OBX')) {
    const valueType = rawField(obx, 2).trim();
    const id = comp(hl7, obx, 3, 1).trim();
    const system = comp(hl7, obx, 3, 3).trim();
    if (valueType === 'ED') {
      binaryItems++; // histogram / scattergram data [Mindray 6.2]; stored with the raw message, not as observations
      continue;
    }
    if (!id) {
      warnings.push({ code: 'OBX_WITHOUT_ID', detail: `OBX-1 ${rawField(obx, 1)}` });
      continue;
    }
    if (id === RECHECK_FLAG_ID && system === '99MRC') {
      recheck = comp(hl7, obx, 5).trim().toUpperCase() === 'T';
    }
    observations.push(obxToObservation(hl7, obx, valueType, id, system));
  }
  if (recheck) for (const o of observations) o.resultStatus = 'rerun';

  const msg: NormalizedAnalyzerMessage = {
    schemaVersion: 1,
    rawMessageId: ctx.rawMessageId as NormalizedAnalyzerMessage['rawMessageId'],
    instrumentId: ctx.instrumentId as NormalizedAnalyzerMessage['instrumentId'],
    adapter: { name: ADAPTER_NAME, version: ADAPTER_VERSION },
    receivedAt: ctx.receivedAt,
    kind: 'result',
    sampleClass: isQc ? 'qc' : 'patient',
    sampleIdReadError: sampleId === '',
    instrumentContext: {
      messageControlId: header.controlId,
      processingId: header.processingId,
      resultType,
      // Patient ID as entered on the analyzer: used only for mismatch warnings, never for matching.
      instrumentPatientId: isQc ? '' : comp(hl7, pid, 3).trim(),
      analysisTime: comp(hl7, obr, 7).trim(),
      binaryItems: String(binaryItems),
    },
    observations,
    warnings,
  };
  if (sampleId) msg.sampleId = sampleId;
  if (isQc) {
    msg.qc = {};
    const lot = comp(hl7, pid, 3).trim(); // PID-3: control lot number in QC messages [Mindray 4.3.3]
    if (lot) msg.qc.lot = lot;
    const level = observations.find((o) => o.instrumentTestCode === '05001'); // Qc Level [Mindray 5.8]
    if (level && level.value.kind === 'qualitative') msg.qc.level = level.value.code;
  }
  return msg;
}

function obxToObservation(hl7: Hl7Message, obx: Hl7Segment, valueType: string, id: string, system: string): Observation {
  const raw = rawField(obx, 5);
  const text = comp(hl7, obx, 5);
  let value: ResultValue;
  if (valueType === 'NM') value = parseNumericField(text);
  else if (valueType === 'IS') value = text.trim() === '' ? { kind: 'absent', reason: 'no-result' } : { kind: 'qualitative', code: text.trim() };
  else value = text.trim() === '' ? { kind: 'absent', reason: 'no-result' } : { kind: 'text', text };

  // OBX-13 user-defined checks: O reagent expired, E edited, e changed via edited source [Mindray 4.3.6]
  const checks = repetitions(hl7, obx, 13).map((s) => s.trim()).filter(Boolean);
  const obs: Observation = {
    instrumentTestCode: id,
    originalValueText: raw,
    value,
    // OBX-8 may hold two flags joined by "~" (the repetition separator), e.g. "H~A" [Mindray 4.3.6]
    abnormalFlags: repetitions(hl7, obx, 8).map((s) => s.trim()).filter(Boolean),
    instrumentFlags: checks.map((c) => ({ code: `OBX13_${c}` })),
    resultStatus: rawField(obx, 11).trim() === 'F' ? 'final' : 'unknown',
    editedOnInstrument: checks.includes('E') || checks.includes('e'),
  };
  if (system) obs.instrumentCodeSystem = system;
  const units = comp(hl7, obx, 6).trim();
  if (units) obs.units = units;
  const ref = comp(hl7, obx, 7).trim();
  if (ref) obs.referenceRangeText = ref;
  return obs;
}

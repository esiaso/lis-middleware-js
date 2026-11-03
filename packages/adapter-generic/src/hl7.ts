import type { GenericHl7Profile, Hl7Locator, NormalizedAnalyzerMessage, Observation, ResultValue } from '@lis/contracts';
import { parseNumericField } from '@lis/domain';
import {
  comp,
  encodeHl7,
  firstSegment,
  hl7Escape,
  hl7Timestamp,
  parseHl7,
  rawField,
  repetitions,
  type Hl7Message,
  type Hl7Segment,
} from '@lis/protocol-hl7v2';
import { emptyMessage, mapStatus, type GenericParseContext } from './common.js';

export const GENERIC_HL7_ADAPTER = 'generic-hl7-mllp';

export interface GenericHl7Header {
  messageType: string;
  controlId: string;
  processingId: string;
  version: string;
  sendingApplication: string;
  sendingFacility: string;
}

export type GenericHl7Inbound =
  | { kind: 'result'; header: GenericHl7Header; messages: NormalizedAnalyzerMessage[]; hl7: Hl7Message }
  /** Stored and acknowledged, never acted on (queries, other events). */
  | { kind: 'unsupported'; header: GenericHl7Header; hl7: Hl7Message };

export function readGenericHeader(hl7: Hl7Message): GenericHl7Header {
  const msh = firstSegment(hl7, 'MSH');
  return {
    messageType: [comp(hl7, msh, 9, 1), comp(hl7, msh, 9, 2)].filter(Boolean).join('^'),
    controlId: rawField(msh, 10),
    processingId: comp(hl7, msh, 11),
    version: comp(hl7, msh, 12),
    sendingApplication: comp(hl7, msh, 3),
    sendingFacility: comp(hl7, msh, 4),
  };
}

/**
 * Decode one MLLP payload with an administrator-supplied profile. Each OBR
 * starts a sample group; OBX segments belong to the group they follow.
 * Invalid UTF-8 (when the profile says UTF-8) throws so the raw bytes are quarantined.
 */
export function parseGenericHl7Payload(payload: Buffer, profile: GenericHl7Profile, ctx: GenericParseContext): GenericHl7Inbound {
  const text = profile.encoding === 'utf-8' ? new TextDecoder('utf-8', { fatal: true }).decode(payload) : payload.toString('latin1');
  const hl7 = parseHl7(text);
  const header = readGenericHeader(hl7);
  if (!profile.resultMessageTypes.includes(header.messageType)) return { kind: 'unsupported', header, hl7 };

  // Split into groups at each OBR. Segments before the first OBR (MSH, PID, PV1, ORC…) are the preamble.
  const preamble: Hl7Segment[] = [];
  const groups: Hl7Segment[][] = [];
  for (const seg of hl7.segments) {
    if (seg.name === 'OBR') groups.push([seg]);
    else if (groups.length === 0) preamble.push(seg);
    else (groups[groups.length - 1] as Hl7Segment[]).push(seg);
  }
  const messages: NormalizedAnalyzerMessage[] = [];
  const preambleSoFar = [...preamble];
  for (const group of groups) {
    messages.push(groupToMessage(hl7, header, group, preambleSoFar, profile, ctx));
    // A PID/ORC inside one group is context for the next, as in a multi-order ORU.
    preambleSoFar.push(...group.filter((s) => s.name !== 'OBR' && s.name !== 'OBX'));
  }
  if (groups.length === 0) {
    const m = emptyMessage(GENERIC_HL7_ADAPTER, ctx, profile.profileVersion);
    m.warnings.push({ code: 'NO_OBR', detail: 'result message without OBR; stored, nothing parsed' });
    messages.push(m);
  }
  return { kind: 'result', header, messages, hl7 };
}

/** The segment a locator points at: first match inside the group, else the latest one before it. */
function locate(group: Hl7Segment[], before: Hl7Segment[], loc: Hl7Locator): Hl7Segment | undefined {
  return group.find((s) => s.name === loc.segment) ?? [...before].reverse().find((s) => s.name === loc.segment);
}

function groupToMessage(
  hl7: Hl7Message,
  header: GenericHl7Header,
  group: Hl7Segment[],
  before: Hl7Segment[],
  p: GenericHl7Profile,
  ctx: GenericParseContext,
): NormalizedAnalyzerMessage {
  const msg = emptyMessage(GENERIC_HL7_ADAPTER, ctx, p.profileVersion);
  msg.instrumentContext['messageControlId'] = header.controlId;
  msg.instrumentContext['messageType'] = header.messageType;

  const sampleId = comp(hl7, locate(group, before, p.sampleId), p.sampleId.field, p.sampleId.component).trim();
  let isQc = false;
  if (p.qcRule) {
    const qcSeg = locate(group, before, p.qcRule.at);
    const values = repetitions(hl7, qcSeg, p.qcRule.at.field).map((r) => (r.split(hl7.delimiters.component)[p.qcRule!.at.component - 1] ?? '').trim());
    isQc = values.some((v) => p.qcRule!.equals.includes(v));
  } else {
    msg.warnings.push({ code: 'NO_QC_RULE', detail: 'profile has no QC rule; QC messages cannot be told apart' });
  }
  msg.sampleClass = isQc ? 'qc' : 'patient';
  if (sampleId) msg.sampleId = sampleId;
  msg.sampleIdReadError = !isQc && sampleId === '';
  if (isQc) msg.qc = sampleId ? { controlName: sampleId } : {};

  let binary = 0;
  for (const obx of group.filter((s) => s.name === 'OBX')) {
    const valueType = comp(hl7, obx, p.valueType.field, p.valueType.component).trim();
    if (p.binaryValueTypes.includes(valueType)) {
      binary++;
      continue;
    }
    const o = toObservation(hl7, obx, valueType, p);
    if (o) msg.observations.push(o);
    else msg.warnings.push({ code: 'OBX_WITHOUT_ID', detail: `OBX-1 ${rawField(obx, 1)}` });
  }
  if (binary) msg.instrumentContext['binaryItems'] = String(binary);
  return msg;
}

function toObservation(hl7: Hl7Message, obx: Hl7Segment, valueType: string, p: GenericHl7Profile): Observation | null {
  const at = (l: Hl7Locator) => comp(hl7, obx, l.field, l.component);
  const code = at(p.testCode).trim();
  if (!code) return null;
  const text = at(p.value);
  let value: ResultValue;
  if (valueType === 'NM' || valueType === 'SN') value = parseNumericField(text);
  else value = text.trim() === '' ? { kind: 'absent', reason: 'no-result' } : { kind: 'text', text: text.slice(0, 4000) };

  const obs: Observation = {
    instrumentTestCode: code,
    originalValueText: rawField(obx, p.value.field),
    value,
    abnormalFlags: repetitions(hl7, obx, p.abnormalFlags.field)
      .map((r) => (r.split(hl7.delimiters.component)[p.abnormalFlags.component - 1] ?? '').trim())
      .filter(Boolean),
    instrumentFlags: [],
    resultStatus: mapStatus(at(p.resultStatus), p.resultStatusMap),
    editedOnInstrument: false,
  };
  if (p.testCodeSystem) {
    const sys = at(p.testCodeSystem).trim();
    if (sys) obs.instrumentCodeSystem = sys;
  }
  const units = at(p.units).trim();
  if (units) obs.units = units;
  const ref = at(p.referenceRange).trim();
  if (ref) obs.referenceRangeText = ref;
  const completed = at(p.completedAt).trim();
  if (completed) obs.completedAtText = completed.slice(0, 26);
  return obs;
}

/**
 * Original-mode HL7 acknowledgement: MSA-1 AA (or AE/AR), MSA-2 echoes the received
 * MSH-10, MSH-11 and MSH-12 echo the received values, MSH-5 addresses the sender.
 * Sent only after the payload is durably stored.
 */
export function buildGenericAck(
  received: GenericHl7Header,
  profile: GenericHl7Profile,
  controlId: string,
  now: Date,
  timeZone: string,
  code: 'AA' | 'AE' | 'AR' = 'AA',
  errorText?: string,
): Buffer {
  const trigger = received.messageType.split('^')[1] ?? '';
  const msh = [
    'MSH',
    '^~\\&',
    hl7Escape(profile.sendingApplication),
    '',
    hl7Escape(received.sendingApplication),
    hl7Escape(received.sendingFacility),
    hl7Timestamp(now, timeZone),
    '',
    trigger ? `ACK^${trigger}` : 'ACK',
    controlId,
    received.processingId || 'P',
    received.version || '2.3.1',
  ];
  const msa = ['MSA', code, hl7Escape(received.controlId)];
  if (code !== 'AA' && errorText) msa.push(hl7Escape(errorText));
  const text = encodeHl7([msh, msa]);
  return profile.encoding === 'utf-8' ? Buffer.from(text, 'utf8') : Buffer.from(text, 'latin1');
}

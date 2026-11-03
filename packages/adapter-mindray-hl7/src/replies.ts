import { DEFAULT_HL7_DELIMITERS, encodeHl7, hl7Escape, hl7Timestamp } from '@lis/protocol-hl7v2';
import type { MindrayHeader } from './parse.js';
import type { MindrayOptions } from './options.js';

const ENC = '^~\\&';

function msh(opts: MindrayOptions, now: Date, type: string, controlId: string, processingId: string): string[] {
  // MSH-1 is implied by encodeHl7. Positions: 2 enc, 3 sending app, 7 time, 9 type, 10 control ID,
  // 11 processing ID, 12 version, 18 charset [Mindray 4.3.1].
  const f: string[] = ['MSH', ENC, hl7Escape(opts.sendingApplication), '', '', '', hl7Timestamp(now, opts.timeZone), '', type, controlId, processingId, '2.3.1', '', '', '', '', '', 'UNICODE'];
  return f;
}

export type AckCode = 'AA' | 'AE' | 'AR';

/**
 * ACK^R01 for an ORU^R01. MSA-2 echoes the received MSH-10 and MSH-11 echoes
 * the received processing ID (P or Q) [Mindray 5.2, 5.4].
 * For AE/AR, MSA-3 carries the text and MSA-6 the status code [Mindray 4.3.2].
 */
export function buildAck(
  received: MindrayHeader,
  controlId: string,
  opts: MindrayOptions,
  now: Date,
  code: AckCode = 'AA',
  error?: { statusCode: number; text: string },
): Buffer {
  const msa = ['MSA', code, hl7Escape(received.controlId)];
  if (code !== 'AA' && error) msa.push(hl7Escape(error.text), '', '', String(error.statusCode));
  const text = encodeHl7([msh(opts, now, 'ACK^R01', controlId, received.processingId || 'P'), msa], DEFAULT_HL7_DELIMITERS);
  return Buffer.from(text, 'utf8');
}

export interface MindrayWorklistAnswer {
  found: boolean;
  sampleId: string;
  patient?: {
    id?: string;
    familyName?: string;
    givenName?: string;
    /** HL7 TS, e.g. "19800131000000". */
    birthDate?: string;
    /** As the document's examples show: "Male" / "Female" [Mindray 4.3.3]. Unverified for the installed model. */
    sex?: string;
  };
  /** PV1-3 point of care / bed, e.g. "ICU^^BedNO1" components [Mindray 4.3.4, 5.5]. */
  location?: { pointOfCare?: string; bed?: string };
  /** OBX values offered in the reply [Mindray 5.5, §6]. Whether the analyzer applies them is UNVERIFIED (B-5). */
  bloodMode?: 'W' | 'P' | 'W_WBCHGB' | 'P_WBCHGB' | 'W_RBCPLT' | 'P_RBCPLT';
  testMode?: 'CBC' | 'CBC+5DIFF';
  ageYears?: string;
  remark?: string;
}

/**
 * ORR^O02 reply to an ORM^O01 worklist query [Mindray 5.5].
 * With a hit: MSH, MSA, PID, PV1, ORC (AF, ORC-2 = sample ID), OBR (OBR-2 = sample ID), OBX.
 * Without a hit the document gives no format; MSH + MSA only is sent until interface testing
 * confirms the expected form (discovery B-5).
 */
export function buildWorklistReply(
  received: MindrayHeader,
  controlId: string,
  answer: MindrayWorklistAnswer,
  opts: MindrayOptions,
  now: Date,
): Buffer {
  const e = (v: string | undefined) => hl7Escape(v ?? '');
  const segs: string[][] = [
    msh(opts, now, 'ORR^O02', controlId, received.processingId || 'P'),
    ['MSA', 'AA', e(received.controlId)],
  ];
  if (answer.found) {
    const p = answer.patient ?? {};
    segs.push(['PID', '1', '', p.id ? `${e(p.id)}^^^^MR` : '', '', `${e(p.familyName)}^${e(p.givenName)}`, '', e(p.birthDate), e(p.sex)]);
    const loc = answer.location;
    segs.push(['PV1', '1', '', loc ? `${e(loc.pointOfCare)}^^${e(loc.bed)}` : '']);
    segs.push(['ORC', 'AF', e(answer.sampleId)]);
    segs.push(['OBR', '1', e(answer.sampleId), '', '00001^Automated Count^99MRC']);
    let n = 0;
    const obx = (type: string, id: string, value: string, units = '') =>
      segs.push(['OBX', String(++n), type, id, '', e(value), units, '', '', '', '', 'F']);
    if (answer.bloodMode) obx('IS', '08002^Blood Mode^99MRC', answer.bloodMode);
    if (answer.testMode) obx('IS', '08003^Test Mode^99MRC', answer.testMode);
    if (answer.ageYears) obx('NM', '30525-0^Age^LN', answer.ageYears, 'yr');
    if (answer.remark) obx('ST', '01001^Remark^99MRC', answer.remark);
  }
  return Buffer.from(encodeHl7(segs, DEFAULT_HL7_DELIMITERS), 'utf8');
}

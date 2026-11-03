import type { InstrumentFlag, NormalizedAnalyzerMessage, Observation, ResultValue } from '@lis/contracts';
import { parseNumericField } from '@lis/domain';
import {
  components,
  field,
  parseTransfer,
  repeats,
  unescape,
  type AstmMessage,
  type AstmRecord,
  type Delimiters,
} from '@lis/protocol-astm';
import { ADAPTER_NAME, ADAPTER_VERSION, type E411Options } from './options.js';

/** Where the analyzer's sample sits; must be echoed unchanged in the reply [e411 HIM F-2]. */
export interface E411SampleLocation {
  sequenceNo: string;
  carrierNo: string;
  positionNo: string;
  sampleType: string;
  containerType: string;
}

export interface E411Query {
  kind: 'order-query' | 'query-cancel';
  sampleId: string;
  sampleIdReadError: boolean;
  location: E411SampleLocation;
  /** Message header comment, e.g. "TSREQ^REAL" (cobas® type only). */
  meaning?: string;
}

export interface ParseContext {
  rawMessageId: string;
  instrumentId: string;
  receivedAt: string;
}

export interface E411ParseResult {
  queries: E411Query[];
  results: NormalizedAnalyzerMessage[];
  errors: string[];
}

/**
 * Parse one ASTM transfer from the e 411 into queries and normalised result messages.
 * Field positions follow [e411 HIM E-6 to E-18] for both dialects.
 */
export function parseE411Transfer(text: Buffer, opts: E411Options, ctx: ParseContext): E411ParseResult {
  // latin1 is a lossless byte-to-char mapping; alarm text is not UTF-8 [e411 HIM E-18].
  const { messages, errors } = parseTransfer(text.toString('latin1'));
  const out: E411ParseResult = { queries: [], results: [], errors: [...errors] };
  for (const msg of messages) {
    if (!msg.complete) out.errors.push('incomplete message (no H … L)');
    const header = msg.records[0];
    const meaning = header ? field(header, 11) || undefined : undefined;
    for (const rec of msg.records) {
      if (rec.type === 'Q') {
        const q = parseQuery(rec, msg.delimiters, opts);
        if ('error' in q) out.errors.push(q.error);
        else out.queries.push(meaning ? { ...q, meaning } : q);
      }
    }
    out.results.push(...parseResultGroups(msg, opts, ctx, out.errors));
  }
  return out;
}

function parseQuery(rec: AstmRecord, d: Delimiters, opts: E411Options): Omit<E411Query, 'meaning'> | { error: string } {
  const c = components(field(rec, 3), d).map((v) => unescape(v, d));
  // cobas®:  ^^<SampleID>^<Seq>^<Carrier>^<Pos>^^<SampleType>^<Container>
  // Elecsys: ^<SampleID>^<Seq>^<Carrier>^<Pos>^^<SampleType>^<Container>   [e411 HIM E-8]
  const o = opts.protocolType === 'cobas' ? 2 : 1;
  const sampleId = (c[o] ?? '').trim();
  const status = field(rec, 13).trim().toUpperCase();
  if (status !== 'O' && status !== 'A') return { error: `query with unknown status "${status}"` };
  return {
    kind: status === 'O' ? 'order-query' : 'query-cancel',
    sampleId,
    sampleIdReadError: sampleId === '' || sampleId.startsWith('@'),
    location: {
      sequenceNo: c[o + 1] ?? '',
      carrierNo: c[o + 2] ?? '',
      positionNo: c[o + 3] ?? '',
      sampleType: c[o + 5] ?? '',
      containerType: c[o + 6] ?? '',
    },
  };
}

function parseResultGroups(
  msg: AstmMessage,
  opts: E411Options,
  ctx: ParseContext,
  errors: string[],
): NormalizedAnalyzerMessage[] {
  const d = msg.delimiters;
  const out: NormalizedAnalyzerMessage[] = [];
  let current: NormalizedAnalyzerMessage | null = null;
  let lastObs: Observation | null = null;

  for (const rec of msg.records) {
    if (rec.type === 'O') {
      current = orderToMessage(rec, d, opts, ctx);
      out.push(current);
      lastObs = null;
    } else if (rec.type === 'R') {
      if (!current) {
        errors.push('result record without order record');
        continue;
      }
      try {
        lastObs = resultToObservation(rec, d, opts);
        current.observations.push(lastObs);
      } catch (e) {
        current.warnings.push({ code: 'R_RECORD_INVALID', detail: (e as Error).message });
        lastObs = null;
      }
    } else if (rec.type === 'C') {
      // A comment after a result carries the data alarm [e411 HIM E-18]; one after an order is not used.
      if (lastObs) lastObs.instrumentFlags.push(commentToFlag(rec, d));
    }
  }
  return out;
}

function orderToMessage(rec: AstmRecord, d: Delimiters, opts: E411Options, ctx: ParseContext): NormalizedAnalyzerMessage {
  const sampleId = unescape(field(rec, 3), d).trim();
  const inst = components(field(rec, 4), d);
  // <SequenceNo>^<CarrierNo>^<PositionNo>^^<SampleType>^<ContainerType> [e411 HIM E-11]
  const sampleType = (inst[4] ?? '').toUpperCase();
  const actionCodes = repeats(field(rec, 12), d).map((a) => a.trim().toUpperCase());
  const isQc = sampleType === 'QC' || sampleType === 'CONTROL' || actionCodes.includes('Q');

  const msg: NormalizedAnalyzerMessage = {
    schemaVersion: 1,
    rawMessageId: ctx.rawMessageId as NormalizedAnalyzerMessage['rawMessageId'],
    instrumentId: ctx.instrumentId as NormalizedAnalyzerMessage['instrumentId'],
    adapter: { name: ADAPTER_NAME, version: ADAPTER_VERSION },
    receivedAt: ctx.receivedAt,
    kind: 'result',
    sampleClass: isQc ? 'qc' : 'patient',
    sampleIdReadError: !isQc && (sampleId === '' || sampleId.startsWith('@')),
    instrumentContext: {
      sequenceNo: inst[0] ?? '',
      carrierNo: inst[1] ?? '',
      positionNo: inst[2] ?? '',
      sampleType: inst[4] ?? '',
      containerType: inst[5] ?? '',
      priority: field(rec, 6),
      dialect: opts.protocolType,
    },
    observations: [],
    warnings: [],
  };
  if (sampleId) msg.sampleId = sampleId;
  if (isQc) {
    // Control name, or "name^lot" per the "QC additional information" setting [e411 HIM B-6, E-11].
    const [controlName, lot] = components(field(rec, 3), d).map((v) => unescape(v, d).trim());
    msg.qc = {};
    if (controlName) msg.qc.controlName = controlName;
    if (lot) msg.qc.lot = lot;
  }
  return msg;
}

function resultToObservation(rec: AstmRecord, d: Delimiters, opts: E411Options): Observation {
  const utid = components(field(rec, 3), d);
  let code: string;
  let dilution: string | undefined;
  let preDiluted: boolean | undefined;
  if (opts.protocolType === 'cobas') {
    // ^^^<HostTestCode>/<Dilution>/<pre-dilution>; dilution is a ratio, pre-dilution "not"/"pre-diluted" [e411 HIM E-15]
    const [c, dil, pre] = (utid[3] ?? '').split('/');
    code = (c ?? '').trim();
    dilution = dil?.trim() || undefined;
    if (pre) preDiluted = pre.trim().toLowerCase() === 'pre-diluted';
  } else {
    // ^^^<ApplicationCode>^<DilutionFactor>^<pre-dilution 0/1> [e411 HIM E-15]
    code = (utid[3] ?? '').trim();
    dilution = utid[4]?.trim() || undefined;
    if (utid[5]) preDiluted = utid[5].trim() === '1';
  }
  if (!code) throw new Error('result without test code');

  const rawValue = field(rec, 4);
  const valueComps = components(rawValue, d);
  const isQualitative = opts.qualitativeTestCodes.includes(code);
  let value: ResultValue;
  let secondaryValue: ResultValue | undefined;
  const instrumentFlags: InstrumentFlag[] = [];
  if (isQualitative) {
    const q = (valueComps[0] ?? '').trim();
    value = q === '' ? { kind: 'absent', reason: 'no-result' } : { kind: 'qualitative', code: q };
    // Cut-off index [e411 HIM E-16]
    secondaryValue = parseNumericField(valueComps[1] ?? '');
  } else {
    value = parseNumericField(valueComps[0] ?? '');
    const messageValue = (valueComps[1] ?? '').trim();
    if (opts.protocolType === 'cobas' && messageValue) instrumentFlags.push({ code: `MSG${messageValue}` });
  }

  const statusRaw = field(rec, 9).trim().toUpperCase();
  const resultStatus: Observation['resultStatus'] =
    opts.protocolType === 'cobas'
      ? statusRaw === 'F'
        ? 'initial'
        : statusRaw === 'C'
          ? 'rerun'
          : 'unknown'
      : statusRaw === 'F'
        ? 'final'
        : 'unknown';
  if (opts.protocolType === 'elecsys' && statusRaw && statusRaw !== 'F') {
    // X: cannot be done, R/V/Y/+: transmitted/released/blocked [e411 HIM E-16]
    instrumentFlags.push({ code: `STATUS_${statusRaw}` });
  }

  const ref = components(field(rec, 6), d).map((s) => s.trim());
  const obs: Observation = {
    instrumentTestCode: code,
    originalValueText: rawValue,
    value,
    abnormalFlags: field(rec, 7).trim() ? [field(rec, 7).trim()] : [],
    instrumentFlags,
    resultStatus,
    editedOnInstrument: false,
  };
  if (secondaryValue && secondaryValue.kind !== 'absent') obs.secondaryValue = secondaryValue;
  const units = unescape(field(rec, 5), d).trim();
  if (units) obs.units = units;
  if (ref[0] || ref[1]) obs.referenceRangeText = `${ref[0] ?? ''}-${ref[1] ?? ''}`;
  if (dilution) obs.dilution = dilution;
  if (preDiluted !== undefined) obs.preDiluted = preDiluted;
  const completed = field(rec, 13).trim();
  if (completed) obs.completedAtText = completed;
  const operator = field(rec, 11).trim();
  if (operator) obs.operatorId = operator;
  return obs;
}

function commentToFlag(rec: AstmRecord, d: Delimiters): InstrumentFlag {
  // cobas®: C|1|I|<alarm no>|I ; Elecsys®: C|1|I|<alarm no>^<message>|I [e411 HIM E-18]
  const [code, text] = components(field(rec, 4), d).map((v) => unescape(v, d).trim());
  const flag: InstrumentFlag = { code: `ALARM${code ?? ''}` };
  if (text) flag.text = text;
  return flag;
}

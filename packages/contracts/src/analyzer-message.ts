import { z } from 'zod';
import { InstrumentId, RawMessageId } from './ids.js';
import { ResultValue } from './values.js';

const IsoDateTime = z.string().datetime({ offset: true });

export const InstrumentFlag = z.object({
  code: z.string().min(1).max(20),
  text: z.string().max(200).optional(),
});
export type InstrumentFlag = z.infer<typeof InstrumentFlag>;

export const Observation = z.object({
  /** e.g. e 411 host test code "10", Mindray OBX-3.1 "6690-2". */
  instrumentTestCode: z.string().min(1).max(40),
  /** e.g. "LN" or "99MRC" for Mindray; absent for e 411. */
  instrumentCodeSystem: z.string().max(20).optional(),
  /** Exactly as received. Never altered. */
  originalValueText: z.string().max(65535),
  value: ResultValue,
  /** Secondary numeric reported alongside a qualitative result, e.g. e 411 cut-off index. */
  secondaryValue: ResultValue.optional(),
  units: z.string().max(40).optional(),
  referenceRangeText: z.string().max(90).optional(),
  abnormalFlags: z.array(z.string().min(1).max(5)).default([]),
  instrumentFlags: z.array(InstrumentFlag).default([]),
  resultStatus: z.enum(['initial', 'rerun', 'final', 'unknown']),
  dilution: z.string().max(20).optional(),
  preDiluted: z.boolean().optional(),
  /** Mindray OBX-13 "E" or "e" [Mindray 4.3.6]. */
  editedOnInstrument: z.boolean().default(false),
  /** Instrument timestamp text as sent (zone-less). Interpreted later with the instrument's zone. */
  completedAtText: z.string().max(26).optional(),
  operatorId: z.string().max(40).optional(),
});
export type Observation = z.infer<typeof Observation>;

export const SampleClass = z.enum(['patient', 'qc', 'calibration', 'unknown']);
export type SampleClass = z.infer<typeof SampleClass>;

export const NormalizedAnalyzerMessage = z.object({
  schemaVersion: z.literal(1),
  rawMessageId: RawMessageId,
  instrumentId: InstrumentId,
  adapter: z.object({ name: z.string().min(1), version: z.string().min(1) }),
  receivedAt: IsoDateTime,
  kind: z.enum(['result', 'order-query', 'query-cancel', 'status']),
  sampleClass: SampleClass,
  /** As sent by the instrument; may be a read-error placeholder such as "@412" on the e 411. */
  sampleId: z.string().max(40).optional(),
  sampleIdReadError: z.boolean().default(false),
  qc: z
    .object({
      controlName: z.string().optional(),
      lot: z.string().optional(),
      level: z.string().optional(),
    })
    .optional(),
  /** Instrument-specific context such as sequence number, carrier and position. */
  instrumentContext: z.record(z.string(), z.string()).default({}),
  observations: z.array(Observation).default([]),
  warnings: z.array(z.object({ code: z.string(), detail: z.string() })).default([]),
});
export type NormalizedAnalyzerMessage = z.infer<typeof NormalizedAnalyzerMessage>;

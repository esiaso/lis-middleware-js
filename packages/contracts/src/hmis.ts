import { z } from 'zod';

/**
 * Canonical HMIS contracts (07 §6.2). ILLUSTRATIVE until the HMIS vendor's
 * documentation arrives (D-1 to D-6, B-6): each HMIS profile maps its own
 * wire format to and from these shapes. No HMIS endpoint is assumed to exist.
 */

const IsoDateTime = z.string().datetime({ offset: true });
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const HmisOrderLine = z
  .object({
    hmisLineId: z.string().min(1).max(64),
    /** HMIS test code, translated through the HMIS code map to a local test code. */
    testCode: z.string().min(1).max(40),
    specimenType: z.string().min(1).max(40).optional(),
    status: z.enum(['active', 'cancelled']).default('active'),
  })
  .strict();
export type HmisOrderLine = z.infer<typeof HmisOrderLine>;

export const HmisOrder = z
  .object({
    hmisOrderId: z.string().min(1).max(64),
    patient: z
      .object({
        mrn: z.string().min(1).max(64),
        familyName: z.string().max(100).optional(),
        givenName: z.string().max(100).optional(),
        birthDate: IsoDate.optional(),
        sex: z.enum(['F', 'M', 'O', 'U']).optional(),
      })
      .strict(),
    encounter: z
      .object({ hmisEncounterId: z.string().min(1).max(64), type: z.string().max(40).optional(), location: z.string().max(80).optional() })
      .strict()
      .optional(),
    priority: z.enum(['routine', 'urgent', 'stat']).default('routine'),
    orderedAt: IsoDateTime,
    orderingClinician: z.string().max(100).optional(),
    lines: z.array(HmisOrderLine).min(1),
    status: z.enum(['active', 'cancelled']).default('active'),
  })
  .strict();
export type HmisOrder = z.infer<typeof HmisOrder>;

export const HmisResultValue = z.discriminatedUnion('type', [
  z.object({ type: z.literal('numeric'), value: z.string().regex(/^[+-]?\d+(\.\d+)?$/), unit: z.string().max(40).optional() }).strict(),
  z.object({ type: z.literal('censored'), comparator: z.enum(['<', '<=', '>', '>=']), value: z.string(), unit: z.string().max(40).optional() }).strict(),
  z
    .object({
      type: z.literal('coded'),
      code: z.string().min(1).max(40),
      /** The code system, such as http://loinc.org for a LOINC answer code; absent for a lab code. */
      system: z.string().max(200).optional(),
      /** The answer's words, from the lab's catalogue. */
      display: z.string().max(80).optional(),
    })
    .strict(),
  z.object({ type: z.literal('text'), text: z.string().max(4000) }).strict(),
]);
export type HmisResultValue = z.infer<typeof HmisResultValue>;

export const HmisResultSubmission = z
  .object({
    idempotencyKey: z.string().min(1).max(200),
    hmisOrderId: z.string(),
    hmisLineId: z.string(),
    /** The patient the order is for, so the HMIS can check the result lands on the right record. Absent in rows written before it was added. */
    patient: z.object({ mrn: z.string().min(1).max(64) }).strict().optional(),
    testCode: z.string(),
    status: z.enum(['final', 'corrected']),
    value: HmisResultValue,
    referenceRange: z.string().max(90).optional(),
    abnormalFlag: z.string().max(10).optional(),
    performedAt: IsoDateTime.optional(),
    approvedBy: z.object({ username: z.string(), displayName: z.string() }).strict(),
    approvedAt: IsoDateTime,
    specimen: z.object({ accessionNo: z.string(), collectedAt: IsoDateTime.optional() }).strict(),
    instrument: z.string().optional(),
    comments: z.array(z.string().max(1000)).default([]),
    correctionOf: z.string().nullable().default(null),
    reason: z.string().max(1000).optional(),
  })
  .strict()
  .refine((s) => s.status !== 'corrected' || (s.correctionOf && s.reason), 'a correction needs correctionOf and a reason');
export type HmisResultSubmission = z.infer<typeof HmisResultSubmission>;

/** 07 §6.5. "ambiguous" means the HMIS may or may not have the result: confirm before any retry. */
export type SubmitOutcome =
  | { kind: 'accepted'; hmisResultId?: string }
  | { kind: 'retryable'; reason: string; retryAfterMs?: number }
  | { kind: 'rejected'; reason: string }
  | { kind: 'ambiguous'; reason: string };

export interface HmisResultState {
  hmisResultId: string;
  idempotencyKey: string;
  status: 'final' | 'corrected';
  value: HmisResultValue;
}

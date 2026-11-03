import { z } from 'zod';

/**
 * Options for the Mindray HL7 v2.3.1 / MLLP adapter, written against the
 * "3107 HL7 Communication Protocol" (Z-110-002557-002-2.0). Which installed
 * model and firmware that document applies to is NOT confirmed (discovery B-3).
 */
export const MindrayOptions = z
  .object({
    /** Value placed in MSH-3 of our replies (the doc's example uses "LIS") [Mindray 5.2]. */
    sendingApplication: z.string().max(180).default('LIS'),
    /** IANA zone used to render HL7 timestamps in replies. */
    timeZone: z.string().default('UTC'),
    /**
     * Reply AA once a message is durably stored even if it fails validation
     * (it is then quarantined). Set false to reply AE/AR instead, but only after
     * interface testing shows how the analyzer reacts to AE/AR (unknown, B-4).
     */
    ackOnStoreEvenIfInvalid: z.boolean().default(true),
  })
  .strict();
export type MindrayOptions = z.infer<typeof MindrayOptions>;

export const ADAPTER_NAME = 'mindray-hl7-mllp';
export const ADAPTER_VERSION = '0.1.0';

import { z } from 'zod';

/**
 * Profiles for the generic drivers. An administrator fills one in from the
 * instrument's own interface manual when no model-specific driver exists.
 *
 * Defaults are the positions defined by the standards (ASTM E1394 result record,
 * HL7 v2 OBX segment). They are NOT claims about any particular instrument: many
 * instruments move fields, and the sample ID position is deliberately required
 * because it differs between instruments (for example the cobas e 411 sends it
 * in O-3 and the cobas c 111 in O-4).
 *
 * Generic drivers only receive results and acknowledge them. They never answer
 * order queries and never download orders: host query needs a model-specific
 * driver because a wrong reply can run the wrong test on a patient sample.
 */

const ResultStatusTarget = z.enum(['initial', 'rerun', 'final']);

/** Instrument status code (e.g. "F") → normalised status. Unmapped codes become "unknown". */
const StatusMap = z.record(z.string().min(1).max(5), ResultStatusTarget);

// ---------- ASTM E1394 ----------

/** A field (and component) in an ASTM record. `field` uses ASTM numbering: position 1 is the record type. */
export const AstmLocator = z
  .object({
    record: z.enum(['P', 'O', 'R']),
    field: z.number().int().min(2).max(40),
    component: z.number().int().min(1).max(12).default(1),
  })
  .strict();
export type AstmLocator = z.infer<typeof AstmLocator>;

const rLoc = (field: number, component = 1) => ({ record: 'R' as const, field, component });
const resultLocator = AstmLocator.refine((l) => l.record === 'R', 'must point into the R (result) record');

export const GenericAstmProfile = z
  .object({
    profile: z.literal('generic-astm'),
    profileVersion: z.literal(1).default(1),
    /** Character set used on the link. latin1 is a lossless byte mapping and the safe default. */
    encoding: z.enum(['latin1', 'utf-8']).default('latin1'),
    /** Required: where the sample barcode is. No default because it differs between instruments. */
    sampleId: AstmLocator.refine((l) => l.record !== 'R', 'sample ID is in the P or O record'),
    /** E1394 universal test ID is R-3 "^^^code"; the code is component 4. */
    testCode: resultLocator.default(rLoc(3, 4)),
    value: resultLocator.default(rLoc(4)),
    units: resultLocator.default(rLoc(5)),
    referenceRange: resultLocator.default(rLoc(6)),
    abnormalFlags: resultLocator.default(rLoc(7)),
    resultStatus: resultLocator.default(rLoc(9)),
    completedAt: resultLocator.default(rLoc(13)),
    resultStatusMap: StatusMap.default({ F: 'final' }),
    /**
     * How to recognise a QC message. E1394 O-12 (action code) "Q" means QC.
     * Messages matching this are never treated as patient results.
     */
    qcRule: z
      .object({
        at: AstmLocator.refine((l) => l.record !== 'R', 'QC is decided per sample: use the P or O record'),
        equals: z.array(z.string().min(1)).min(1),
      })
      .strict()
      .default({ at: { record: 'O', field: 12, component: 1 }, equals: ['Q'] }),
  })
  .strict();
export type GenericAstmProfile = z.infer<typeof GenericAstmProfile>;

// ---------- HL7 v2 over MLLP ----------

/** A field (and component) in an HL7 segment. `field` uses HL7 numbering (MSH-1 is the field separator). */
export const Hl7Locator = z
  .object({
    segment: z.string().regex(/^[A-Z][A-Z0-9]{2}$/, 'three-character segment name'),
    field: z.number().int().min(1).max(100),
    component: z.number().int().min(1).max(20).default(1),
  })
  .strict();
export type Hl7Locator = z.infer<typeof Hl7Locator>;

const obx = (field: number, component = 1) => ({ segment: 'OBX', field, component });
const obxLocator = Hl7Locator.refine((l) => l.segment === 'OBX', 'must point into OBX');

export const GenericHl7Profile = z
  .object({
    profile: z.literal('generic-hl7-mllp'),
    profileVersion: z.literal(1).default(1),
    encoding: z.enum(['utf-8', 'latin1']).default('utf-8'),
    /** MSH-9 message type and trigger, e.g. "ORU^R01". Other types are stored and acknowledged, never parsed. */
    resultMessageTypes: z.array(z.string().regex(/^[A-Z0-9]{3}\^[A-Z0-9]{3}$/)).min(1).default(['ORU^R01']),
    /** Required: where the sample barcode is (often OBR-2, OBR-3 or SPM-2 depending on the instrument). */
    sampleId: Hl7Locator.refine((l) => l.segment !== 'OBX', 'sample ID is not in OBX'),
    testCode: obxLocator.default(obx(3, 1)),
    /** Optional coding system component (OBX-3.3), e.g. "LN". Absent means no system. */
    testCodeSystem: obxLocator.optional(),
    /** OBX-2 value type decides numeric vs text parsing ("NM" numeric). */
    valueType: obxLocator.default(obx(2)),
    value: obxLocator.default(obx(5)),
    units: obxLocator.default(obx(6)),
    referenceRange: obxLocator.default(obx(7)),
    abnormalFlags: obxLocator.default(obx(8)),
    resultStatus: obxLocator.default(obx(11)),
    completedAt: obxLocator.default(obx(14)),
    resultStatusMap: StatusMap.default({ F: 'final' }),
    /** OBX value types that carry binary data (histograms, images). Kept with the raw message, not parsed. */
    binaryValueTypes: z.array(z.string().min(2).max(3)).default(['ED']),
    /** How to recognise QC. Absent means "never QC", which the registration screen warns about. */
    qcRule: z
      .object({ at: Hl7Locator, equals: z.array(z.string().min(1)).min(1) })
      .strict()
      .optional(),
    /** Value placed in MSH-3 of our ACKs. */
    sendingApplication: z.string().max(180).default('LIS'),
  })
  .strict();
export type GenericHl7Profile = z.infer<typeof GenericHl7Profile>;

export const GenericProfile = z.discriminatedUnion('profile', [GenericAstmProfile, GenericHl7Profile]);
export type GenericProfile = z.infer<typeof GenericProfile>;

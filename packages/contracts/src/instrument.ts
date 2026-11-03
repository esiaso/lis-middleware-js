import { z } from 'zod';
import { InstrumentId } from './ids.js';
import { InstrumentConnectionConfig, isGenericAdapter } from './config.js';
import { GenericAstmProfile, GenericHl7Profile } from './generic-profiles.js';
import { VerificationStatus } from './status.js';

const IsoDateTime = z.string().datetime({ offset: true });
const UserRef = z.string().min(1).max(100);

export const InstrumentDiscipline = z.enum([
  'chemistry',
  'immunoassay',
  'haematology',
  'coagulation',
  'urinalysis',
  'blood-gas',
  'electrolytes',
  'microbiology',
  'molecular',
  'other',
]);
export type InstrumentDiscipline = z.infer<typeof InstrumentDiscipline>;

/**
 * An instrument as an administrator registers it. Identity fields are the ones
 * the full inventory asks for (discovery D-26). A new registration always starts
 * UNVERIFIED and disabled; status changes only through recorded evidence
 * (see `VerificationEvidence` and the domain's instrument lifecycle).
 */
export const InstrumentRegistration = z
  .object({
    instrumentId: InstrumentId,
    displayName: z.string().min(1).max(80),
    manufacturer: z.string().min(1).max(80),
    model: z.string().min(1).max(80),
    serialNo: z.string().max(60).optional(),
    softwareVersion: z.string().max(60).optional(),
    discipline: InstrumentDiscipline,
    location: z.string().max(120).optional(),
    /** Title, document number and revision of the interface manual the profile was built from. */
    interfaceManualRef: z.string().max(200).optional(),
    connection: InstrumentConnectionConfig,
  })
  .strict()
  .superRefine((r, ctx) => {
    if (r.connection.instrumentId !== r.instrumentId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['connection', 'instrumentId'], message: 'must equal instrumentId' });
    }
    const adapter = r.connection.adapter;
    if (isGenericAdapter(adapter)) {
      const schema = adapter === 'generic-astm' ? GenericAstmProfile : GenericHl7Profile;
      const parsed = schema.safeParse(r.connection.adapterOptions);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          ctx.addIssue({ ...issue, path: ['connection', 'adapterOptions', ...issue.path] });
        }
      }
      if (!r.interfaceManualRef) {
        // A generic profile is only as good as the manual it came from.
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['interfaceManualRef'], message: 'required for a generic profile' });
      }
    }
  });
export type InstrumentRegistration = z.infer<typeof InstrumentRegistration>;

/** Evidence that moves an instrument forward. Stored with the audit event. */
export const VerificationEvidence = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('interface-test'),
      /** Vendor field engineer, or biomedical engineer where the vendor cannot attend. */
      testedBy: z.string().min(1).max(100),
      organisation: z.string().min(1).max(100),
      testedAt: IsoDateTime,
      /** Reference to the signed interface verification record (12 §4). */
      recordRef: z.string().min(1).max(200),
      softwareVersion: z.string().min(1).max(60),
    })
    .strict(),
  z
    .object({
      kind: z.literal('lab-acceptance'),
      signedBy: UserRef,
      signedAt: IsoDateTime,
      /** Reference to the parallel-run report against the acceptance criteria (12 §5). */
      acceptanceRef: z.string().min(1).max(200),
    })
    .strict(),
  z.object({ kind: z.literal('suspension'), reason: z.string().min(10).max(1000) }).strict(),
  z.object({ kind: z.literal('reverification'), reason: z.string().min(10).max(1000) }).strict(),
]);
export type VerificationEvidence = z.infer<typeof VerificationEvidence>;

export const InstrumentState = z
  .object({
    registration: InstrumentRegistration,
    verificationStatus: VerificationStatus,
    enabled: z.boolean(),
    /** Software version the current status was granted for. */
    verifiedSoftwareVersion: z.string().optional(),
  })
  .strict();
export type InstrumentState = z.infer<typeof InstrumentState>;

// ---------- Versioned test mappings ----------

export const TestMapping = z
  .object({
    localTestCode: z.string().min(1).max(40),
    instrumentTestCode: z.string().min(1).max(40),
    instrumentCodeSystem: z.string().max(20).optional(),
    direction: z.enum(['order', 'result', 'both']),
    expectedUnits: z.string().max(40).optional(),
    decimals: z.number().int().min(0).max(6).optional(),
    /** Instrument qualitative code → local code, e.g. {"-1":"NEG","1":"POS"}. */
    qualitativeMap: z.record(z.string(), z.string()).optional(),
    reportable: z.boolean().default(true),
    /** Research-use-only parameters are never reported. */
    ruo: z.boolean().default(false),
  })
  .strict();
export type TestMapping = z.infer<typeof TestMapping>;

export const MappingSetStatus = z.enum(['draft', 'approved', 'active', 'retired']);
export type MappingSetStatus = z.infer<typeof MappingSetStatus>;

export const TestMappingSet = z
  .object({
    instrumentId: InstrumentId,
    versionNo: z.number().int().positive(),
    status: MappingSetStatus,
    createdBy: UserRef,
    approvedBy: UserRef.optional(),
    approvedAt: IsoDateTime.optional(),
    mappings: z.array(TestMapping),
  })
  .strict()
  .superRefine((s, ctx) => {
    const seen = new Set<string>();
    s.mappings.forEach((m, i) => {
      const dirs = m.direction === 'both' ? ['order', 'result'] : [m.direction];
      for (const d of dirs) {
        const key = `${m.instrumentTestCode}\u0000${m.instrumentCodeSystem ?? ''}\u0000${d}`;
        if (seen.has(key)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['mappings', i], message: `duplicate ${d} mapping for instrument code ${m.instrumentTestCode}` });
        }
        seen.add(key);
      }
    });
    if (s.status !== 'draft' && !s.approvedBy) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['approvedBy'], message: `required when status is ${s.status}` });
    }
  });
export type TestMappingSet = z.infer<typeof TestMappingSet>;

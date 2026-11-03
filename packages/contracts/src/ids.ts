import { z } from 'zod';

/** Branded identifiers stop an accession number being passed where a specimen ID is expected. */
export const Uuid = z.string().uuid();

export const PatientId = Uuid.brand<'PatientId'>();
export type PatientId = z.infer<typeof PatientId>;

export const SpecimenId = Uuid.brand<'SpecimenId'>();
export type SpecimenId = z.infer<typeof SpecimenId>;

export const CorrelationId = Uuid.brand<'CorrelationId'>();
export type CorrelationId = z.infer<typeof CorrelationId>;

export const RawMessageId = Uuid.brand<'RawMessageId'>();
export type RawMessageId = z.infer<typeof RawMessageId>;

/**
 * Barcode as sent to instruments. Printable ASCII, no spaces.
 * Max 22: the cobas e 411 Sample ID limit [e411 HIM E-8, E-11]; Mindray OBR-3 recommends 22 [Mindray 4.3.5].
 * The hospital label specification (discovery item B-8) may tighten this further.
 */
export const Barcode = z
  .string()
  .min(1)
  .max(22)
  .regex(/^[\x21-\x7E]+$/, 'printable ASCII without spaces')
  .brand<'Barcode'>();
export type Barcode = z.infer<typeof Barcode>;

export const InstrumentId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{2,39}$/, 'lowercase letters, digits and hyphens, 3-40 chars')
  .brand<'InstrumentId'>();
export type InstrumentId = z.infer<typeof InstrumentId>;

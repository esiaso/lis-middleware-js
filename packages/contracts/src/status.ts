import { z } from 'zod';

/** The result states shown to users. Kept distinct so "sent" is never mistaken for "confirmed". */
export const ResultDisplayStatus = z.enum([
  'received',
  'reviewed',
  'approved',
  'queued',
  'sent',
  'hmis_confirmed',
  'failed',
]);
export type ResultDisplayStatus = z.infer<typeof ResultDisplayStatus>;

export const VerificationStatus = z.enum(['unverified', 'vendor_tested', 'lab_accepted', 'suspended']);
export type VerificationStatus = z.infer<typeof VerificationStatus>;

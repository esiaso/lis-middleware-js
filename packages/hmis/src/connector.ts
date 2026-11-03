import type { HmisOrder, HmisResultState, HmisResultSubmission, SubmitOutcome } from '@lis/contracts';

/**
 * What the middleware needs from any HMIS (07 §6.1). A real profile
 * (REST, HL7, or FHIR if the live HMIS supports it) is written once the
 * vendor documentation arrives; until then `SimulatedHmis` stands in.
 */
export interface HmisConnector {
  readonly profile: string;
  pullOrders(cursor: string | null): Promise<{ orders: HmisOrder[]; nextCursor: string | null }>;
  submitResult(r: HmisResultSubmission, idempotencyKey: string): Promise<SubmitOutcome>;
  /** Read-back used to settle ambiguous outcomes and to confirm delivery. Null if the HMIS has no such result. */
  findResult(lookup: { idempotencyKey: string; hmisOrderId: string; hmisLineId: string }): Promise<HmisResultState | null>;
}

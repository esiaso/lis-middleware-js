import { z } from 'zod';
import { HmisOrder, HmisResultSubmission, type HmisResultState, type SubmitOutcome } from '@lis/contracts';
import type { HmisConnector } from './connector.js';

export type SimulatedFault =
  /** 503 before the body is processed: nothing stored. */
  | { kind: 'unavailable'; retryAfterMs?: number }
  /** Stored, but the response is lost (timeout after send): the hard case. */
  | { kind: 'lost-response' }
  /** 422 validation error. */
  | { kind: 'reject'; reason: string };

/**
 * In-memory stand-in HMIS for development, tests and demos (12 §2 "HMIS
 * simulator"). Honours idempotency keys like a well-behaved HMIS would;
 * `honourIdempotency: false` models one that does not (T-20). Faults are
 * queued and consumed one per submission.
 */
export class SimulatedHmis implements HmisConnector {
  readonly profile = 'simulated@1';
  readonly results = new Map<string, HmisResultState & { submission: HmisResultSubmission }>();
  /** Every submission that reached "storage", including duplicates when idempotency is off. */
  readonly stored: HmisResultSubmission[] = [];
  readonly #orders: HmisOrder[] = [];
  readonly #faults: SimulatedFault[] = [];
  #seq = 0;

  constructor(private readonly opts: { honourIdempotency?: boolean; pageSize?: number } = {}) {}

  /** Add an order to the feed, as if a clinician placed it in the HMIS. */
  placeOrder(order: z.input<typeof HmisOrder>): void {
    this.#orders.push(HmisOrder.parse(order));
  }

  injectFault(f: SimulatedFault): void {
    this.#faults.push(f);
  }

  async pullOrders(cursor: string | null): Promise<{ orders: HmisOrder[]; nextCursor: string | null }> {
    const from = cursor ? Number(cursor) : 0;
    const size = this.opts.pageSize ?? 50;
    const orders = this.#orders.slice(from, from + size);
    const next = from + orders.length;
    return { orders, nextCursor: orders.length === 0 ? cursor : String(next) };
  }

  async submitResult(r: HmisResultSubmission, idempotencyKey: string): Promise<SubmitOutcome> {
    const parsed = HmisResultSubmission.safeParse(r);
    if (!parsed.success) return { kind: 'rejected', reason: `422 ${parsed.error.issues[0]?.message ?? 'invalid'}` };
    const fault = this.#faults.shift();
    if (fault?.kind === 'unavailable') return fault.retryAfterMs === undefined ? { kind: 'retryable', reason: '503' } : { kind: 'retryable', reason: '503', retryAfterMs: fault.retryAfterMs };
    if (fault?.kind === 'reject') return { kind: 'rejected', reason: `422 ${fault.reason}` };
    if (!this.#orders.some((o) => o.hmisOrderId === r.hmisOrderId && o.lines.some((l) => l.hmisLineId === r.hmisLineId))) {
      return { kind: 'rejected', reason: '404 order line unknown' };
    }

    const existing = this.results.get(idempotencyKey);
    let id: string;
    if (existing && this.opts.honourIdempotency !== false) {
      id = existing.hmisResultId;
    } else {
      id = `HR-${++this.#seq}`;
      this.stored.push(parsed.data);
      this.results.set(idempotencyKey, { hmisResultId: id, idempotencyKey, status: parsed.data.status, value: parsed.data.value, submission: parsed.data });
    }
    if (fault?.kind === 'lost-response') return { kind: 'ambiguous', reason: 'timeout after request was sent' };
    return { kind: 'accepted', hmisResultId: id };
  }

  async findResult(lookup: { idempotencyKey: string; hmisOrderId: string; hmisLineId: string }): Promise<HmisResultState | null> {
    const r = this.results.get(lookup.idempotencyKey);
    if (!r) return null;
    const { submission: _s, ...state } = r;
    return state;
  }
}

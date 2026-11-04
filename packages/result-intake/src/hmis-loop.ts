import type { Db } from '@lis/db';
import type { HmisConnector } from '@lis/hmis';
import { deliverOutbox, pollOrders, type DeliveryReport } from '@lis/lab';

export interface HmisLoopOptions {
  db: Db;
  hmis: HmisConnector;
  worker: string;
  signal: AbortSignal;
  /** How often to ask the HMIS for changed orders. */
  pollEveryMs: number;
  /** How often to look for released results to send. */
  deliverEveryMs?: number;
  onPull?: (r: { received: number; created: number }) => void;
  onDelivery?: (r: DeliveryReport) => void;
  /** `what` says which half failed; the loop carries on either way. */
  onError?: (what: 'orders' | 'results', e: Error) => void;
}

/**
 * The jobs worker's HMIS half (07 §6, A-30): pull changed orders on a
 * timer and send released results from the outbox. A failure in one half
 * never stops the other, and neither stops the analyzer intake.
 */
export async function runHmisLoop(o: HmisLoopOptions): Promise<void> {
  const deliverEvery = o.deliverEveryMs ?? 5000;
  let nextPull = 0;
  let nextDeliver = 0;
  while (!o.signal.aborted) {
    const now = Date.now();
    if (now >= nextPull) {
      try {
        const r = await pollOrders(o.db, o.hmis);
        if (r.received > 0) o.onPull?.(r);
      } catch (e) {
        o.onError?.('orders', e as Error);
      }
      nextPull = Date.now() + o.pollEveryMs;
    }
    if (now >= nextDeliver) {
      try {
        // Keep sending while there is a full batch waiting.
        for (;;) {
          const sent = await deliverOutbox(o.db, o.hmis, o.worker, 10);
          sent.forEach((x) => o.onDelivery?.(x));
          if (sent.length < 10 || o.signal.aborted) break;
        }
      } catch (e) {
        o.onError?.('results', e as Error);
      }
      nextDeliver = Date.now() + deliverEvery;
    }
    const wait = Math.max(50, Math.min(nextPull, nextDeliver) - Date.now());
    await new Promise<void>((resolve) => {
      const stop = () => (clearTimeout(t), resolve());
      const t = setTimeout(() => (o.signal.removeEventListener('abort', stop), resolve()), wait);
      o.signal.addEventListener('abort', stop, { once: true });
    });
  }
}

/** LIMS_HMIS_POLL_SECONDS: 30 by default, 10 to 3600. */
export function pollEveryMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['LIMS_HMIS_POLL_SECONDS']?.trim();
  const s = raw ? Number(raw) : 30;
  if (!Number.isInteger(s) || s < 10 || s > 3600) throw new Error('LIMS_HMIS_POLL_SECONDS must be a whole number of seconds from 10 to 3600');
  return s * 1000;
}

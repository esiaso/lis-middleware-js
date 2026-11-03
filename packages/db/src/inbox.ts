import type { Db } from './client.js';

export interface ClaimedInbox {
  id: string;
  source: string;
  externalId: string;
  rawMessageId: string | null;
  attempts: number;
}

/**
 * Claim up to `limit` due inbox rows (08 §2). SKIP LOCKED lets several jobs
 * workers share the queue without blocking each other; the lease lets a
 * reaper recover rows from a worker that died mid-handler.
 */
export async function claimInbox(db: Db, worker: string, limit = 10, leaseSeconds = 120, sourcePrefix = ''): Promise<ClaimedInbox[]> {
  const rows = await db.$queryRaw<{ id: string; source: string; external_id: string; raw_message_id: string | null; attempts: number }[]>`
    UPDATE inbox_message SET status = 'IN_PROGRESS', leased_by = ${worker},
           lease_until = now() + make_interval(secs => ${leaseSeconds}), attempts = attempts + 1
     WHERE id IN (
       SELECT id FROM inbox_message
        WHERE status IN ('PENDING', 'FAILED') AND available_at <= now() AND source LIKE ${sourcePrefix + '%'}
        ORDER BY available_at, id
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED)
     RETURNING id, source, external_id, raw_message_id, attempts`;
  return rows.map((r) => ({ id: r.id, source: r.source, externalId: r.external_id, rawMessageId: r.raw_message_id, attempts: r.attempts }));
}

type Tx = Parameters<Parameters<Db['$transaction']>[0]>[0];

/**
 * Mark done inside the handler's own transaction, only if we still hold the lease.
 * Throws when the lease was lost, which rolls the handler's writes back.
 */
export async function completeInbox(tx: Tx, id: string, worker: string): Promise<void> {
  const n = await tx.$executeRaw`
    UPDATE inbox_message SET status = 'DONE', leased_by = NULL, lease_until = NULL, last_error = NULL
     WHERE id = ${id}::uuid AND leased_by = ${worker} AND status = 'IN_PROGRESS'`;
  if (n !== 1) throw new LeaseLostError(id);
}

export class LeaseLostError extends Error {
  constructor(id: string) {
    super(`inbox lease lost for ${id}`);
    this.name = 'LeaseLostError';
  }
}

/** Retry later with backoff, or give up (DEAD) when the error is permanent or attempts are exhausted. */
export async function failInbox(db: Db, id: string, worker: string, error: string, opts: { permanent?: boolean; maxAttempts?: number; retryDelaySeconds?: number } = {}): Promise<void> {
  const max = opts.maxAttempts ?? 8;
  const delay = opts.retryDelaySeconds ?? 30;
  await db.$executeRaw`
    UPDATE inbox_message
       SET status = CASE WHEN ${opts.permanent ?? false} OR attempts >= ${max} THEN 'DEAD'::"QueueStatus" ELSE 'FAILED'::"QueueStatus" END,
           available_at = now() + make_interval(secs => ${delay} * power(2, LEAST(attempts - 1, 6))),
           leased_by = NULL, lease_until = NULL, last_error = ${error.slice(0, 2000)}
     WHERE id = ${id}::uuid AND leased_by = ${worker}`;
}

/** Return rows whose worker died (lease expired) to the queue. */
export async function reapInbox(db: Db): Promise<number> {
  return db.$executeRaw`
    UPDATE inbox_message SET status = 'FAILED', leased_by = NULL, lease_until = NULL,
           last_error = COALESCE(last_error, 'lease expired (worker stopped mid-handler)')
     WHERE status = 'IN_PROGRESS' AND lease_until < now()`;
}

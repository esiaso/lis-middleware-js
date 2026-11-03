import type { Db } from './client.js';

export interface Lease {
  instrumentId: string;
  owner: string;
  epoch: bigint;
}

/**
 * Take the connection lease for an instrument (03 "Single owner per instrument").
 * Succeeds if nobody holds it, it expired, or we already hold it; the epoch
 * (fencing token) increases on every acquisition. Returns null when another
 * live owner holds it: the worker must exit, not open the port.
 */
export async function acquireLease(db: Db, instrumentId: string, owner: string, ttlSeconds = 30): Promise<Lease | null> {
  const rows = await db.$queryRaw<{ epoch: bigint }[]>`
    INSERT INTO instrument_connection_lease (instrument_id, owner, epoch, lease_until)
    VALUES (${instrumentId}, ${owner}, 1, now() + make_interval(secs => ${ttlSeconds}))
    ON CONFLICT (instrument_id) DO UPDATE
      SET owner = EXCLUDED.owner,
          epoch = instrument_connection_lease.epoch + 1,
          lease_until = EXCLUDED.lease_until
      WHERE instrument_connection_lease.lease_until < now()
         OR instrument_connection_lease.owner = EXCLUDED.owner
    RETURNING epoch`;
  const row = rows[0];
  return row ? { instrumentId, owner, epoch: BigInt(row.epoch) } : null;
}

/** Extend the lease. False means it was lost: close the port and stop ACKing immediately. */
export async function renewLease(db: Db, lease: Lease, ttlSeconds = 30): Promise<boolean> {
  const n = await db.$executeRaw`
    UPDATE instrument_connection_lease
       SET lease_until = now() + make_interval(secs => ${ttlSeconds})
     WHERE instrument_id = ${lease.instrumentId} AND owner = ${lease.owner} AND epoch = ${lease.epoch}`;
  return n === 1;
}

/** Give the lease up on clean shutdown so a restart does not wait for expiry. */
export async function releaseLease(db: Db, lease: Lease): Promise<void> {
  await db.$executeRaw`
    UPDATE instrument_connection_lease SET lease_until = now()
     WHERE instrument_id = ${lease.instrumentId} AND owner = ${lease.owner} AND epoch = ${lease.epoch}`;
}

import { createHash } from 'node:crypto';
import { uuidv7, type Db, type JsonInput } from '@lis/db';
import type { Tx } from './tx.js';

export interface AuditInput {
  actor: string;
  action: string;
  entityType: string;
  entityId: string;
  reason?: string;
  correlationId?: string;
  before?: unknown;
  after?: unknown;
}

const GENESIS = '0'.repeat(64);
/** Serialises chain appends; any constant works as long as only audit uses it. */
const AUDIT_LOCK = 724_101;

/** Stable JSON (sorted keys) so the same event always hashes the same. */
function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, val: unknown) => {
    if (typeof val === 'bigint') return val.toString();
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      return Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    }
    return val;
  });
}

function eventHash(prevHash: string, e: { id: string; at: string } & AuditInput): string {
  return createHash('sha256')
    .update(prevHash)
    .update('\n')
    .update(canonical({ id: e.id, at: e.at, actor: e.actor, action: e.action, entityType: e.entityType, entityId: e.entityId, reason: e.reason ?? null, correlationId: e.correlationId ?? null, before: e.before ?? null, after: e.after ?? null }))
    .digest('hex');
}

/**
 * Append to the clinical audit trail inside the caller's transaction (10 §8).
 * Each event's hash covers the previous hash, so any edit or deletion breaks
 * the chain from that point on. The table is also append-only by trigger.
 */
export async function appendAudit(tx: Tx, e: AuditInput): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${AUDIT_LOCK})`;
  const last = await tx.auditEvent.findFirst({ orderBy: { seq: 'desc' }, select: { hash: true } });
  const prevHash = last?.hash ?? GENESIS;
  const id = uuidv7();
  const at = new Date();
  const hash = eventHash(prevHash, { ...e, id, at: at.toISOString() });
  await tx.auditEvent.create({
    data: {
      id,
      at,
      actor: e.actor,
      action: e.action,
      entityType: e.entityType,
      entityId: e.entityId,
      reason: e.reason ?? null,
      correlationId: e.correlationId ?? null,
      ...(e.before !== undefined ? { before: e.before as JsonInput } : {}),
      ...(e.after !== undefined ? { after: e.after as JsonInput } : {}),
      prevHash,
      hash,
    },
  });
}

/** Recompute the whole chain. Used by the nightly check and the auditor's export. */
export async function verifyAuditChain(db: Db): Promise<{ ok: true; count: number; head: string } | { ok: false; brokenAtSeq: bigint }> {
  let prev = GENESIS;
  let count = 0;
  let cursor: bigint | undefined;
  for (;;) {
    const page = await db.auditEvent.findMany({ orderBy: { seq: 'asc' }, take: 500, ...(cursor !== undefined ? { where: { seq: { gt: cursor } } } : {}) });
    if (page.length === 0) break;
    for (const r of page) {
      const input: AuditInput = { actor: r.actor, action: r.action, entityType: r.entityType, entityId: r.entityId };
      if (r.reason !== null) input.reason = r.reason;
      if (r.correlationId !== null) input.correlationId = r.correlationId;
      if (r.before !== null) input.before = r.before;
      if (r.after !== null) input.after = r.after;
      const expected = eventHash(prev, { ...input, id: r.id, at: r.at.toISOString() });
      if (r.prevHash !== prev || r.hash !== expected) return { ok: false, brokenAtSeq: r.seq };
      prev = r.hash;
      count++;
      cursor = r.seq;
    }
  }
  return { ok: true, count, head: prev };
}

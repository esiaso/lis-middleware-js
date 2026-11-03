import type { HmisResultSubmission, SubmitOutcome } from '@lis/contracts';
import { uuidv7, type Db } from '@lis/db';
import { confirmation, deliveryOutcome } from '@lis/domain';
import type { HmisConnector } from '@lis/hmis';
import { appendAudit } from './audit.js';
import { loadResult, saveResult } from './results.js';

export interface DeliveryReport {
  outboxId: string;
  idempotencyKey: string;
  outcome: SubmitOutcome['kind'] | 'confirmed' | 'not-found';
  resultStatus: string;
}

const MAX_ATTEMPTS = 10;

/**
 * Deliver released results to the HMIS (08 §3). One in-flight attempt per
 * row (SKIP LOCKED + lease). An ambiguous outcome is settled by read-back
 * before anything is resent, so the HMIS never gets a duplicate even if it
 * ignores idempotency keys. Every attempt is recorded.
 */
export async function deliverOutbox(db: Db, hmis: HmisConnector, worker: string, limit = 10): Promise<DeliveryReport[]> {
  const claimed = await db.$queryRaw<{ id: string }[]>`
    UPDATE outbox_message SET status = 'IN_PROGRESS', leased_by = ${worker}, lease_until = now() + interval '2 minutes', attempts = attempts + 1
     WHERE id IN (SELECT id FROM outbox_message WHERE status IN ('PENDING', 'FAILED') AND available_at <= now()
                  ORDER BY available_at, id LIMIT ${limit} FOR UPDATE SKIP LOCKED)
     RETURNING id`;
  const out: DeliveryReport[] = [];
  for (const { id } of claimed) out.push(await deliverOne(db, hmis, worker, id));
  return out;
}

async function deliverOne(db: Db, hmis: HmisConnector, worker: string, outboxId: string): Promise<DeliveryReport> {
  const row = await db.outboxMessage.findUniqueOrThrow({ where: { id: outboxId } });
  const submission = row.payload as unknown as HmisResultSubmission;
  const resultId = row.resultId as string;
  const started = new Date();
  const loaded = await loadResult(db, resultId);
  const lookup = { idempotencyKey: row.idempotencyKey, hmisOrderId: submission.hmisOrderId, hmisLineId: submission.hmisLineId };

  let outcome: DeliveryReport['outcome'];
  let next = loaded.aggregate;
  let detail: string | undefined;
  if (loaded.aggregate.needsConfirmation) {
    // Last attempt was ambiguous: ask before sending again.
    const found = await hmis.findResult(lookup);
    next = confirmation(next, found ? { matches: found.idempotencyKey === row.idempotencyKey } : null);
    outcome = found ? 'confirmed' : 'not-found';
    if (!found) {
      const o = await hmis.submitResult(submission, row.idempotencyKey);
      next = deliveryOutcome(next, o, row.attempts >= MAX_ATTEMPTS);
      outcome = o.kind;
      detail = 'reason' in o ? o.reason : undefined;
    }
  } else {
    const o = await hmis.submitResult(submission, row.idempotencyKey);
    next = deliveryOutcome(next, o, row.attempts >= MAX_ATTEMPTS);
    outcome = o.kind;
    detail = 'reason' in o ? o.reason : undefined;
    if (o.kind === 'accepted') {
      // Read-back confirms what the HMIS stored (HMIS_CONFIRMED is never assumed from a 2xx).
      const found = await hmis.findResult(lookup);
      next = confirmation(next, found ? { matches: found.idempotencyKey === row.idempotencyKey } : null);
    }
  }

  const done = next.status === 'sent' || next.status === 'hmis_confirmed';
  const dead = next.status === 'failed';
  const retryAfter = outcome === 'ambiguous' ? 5 : 30 * 2 ** Math.min(row.attempts - 1, 6);
  await db.$transaction(async (tx) => {
    const fresh = await loadResult(tx, resultId);
    await saveResult(tx, fresh, { ...next, versions: fresh.aggregate.versions }, worker);
    await tx.deliveryAttempt.create({ data: { id: uuidv7(), outboxId, startedAt: started, finishedAt: new Date(), outcome, detail: detail ?? null } });
    await tx.outboxMessage.update({
      where: { id: outboxId },
      data: {
        status: done ? 'DONE' : dead ? 'DEAD' : 'FAILED',
        leasedBy: null,
        leaseUntil: null,
        lastError: done ? null : (detail ?? outcome),
        availableAt: new Date(Date.now() + retryAfter * 1000),
      },
    });
    await tx.resultEvent.create({ data: { id: uuidv7(), resultId, kind: 'delivery', versionNo: next.selectedVersionNo ?? null, actor: `system:${worker}`, detail: { outcome, status: next.status } } });
    if (done || dead) {
      await appendAudit(tx, { actor: `system:${worker}`, action: done ? 'result.delivered' : 'result.delivery_failed', entityType: 'result', entityId: resultId, after: { status: next.status, outcome, idempotencyKey: row.idempotencyKey } });
    }
  });
  return { outboxId, idempotencyKey: row.idempotencyKey, outcome, resultStatus: next.status };
}

import type { Db } from '@lis/db';
import { appendAudit } from './audit.js';
import { WorkflowRejected } from './results.js';

/**
 * Close an unmatched observation without attaching it to a patient
 * (for example a calibrator run under a patient rack, or a duplicate that
 * was re-run under the right barcode). Attaching an unmatched observation to
 * a specimen is not offered yet: it needs the second-person check in 10 §2.
 */
export async function dismissUnmatched(db: Db, unmatchedId: string, user: string, reason: string): Promise<void> {
  const why = reason.trim();
  if (why.length < 5) throw new WorkflowRejected({ code: 'REASON_REQUIRED', detail: 'give a reason of at least 5 characters' });
  await db.$transaction(async (tx) => {
    const n = await tx.unmatchedResult.updateMany({
      where: { id: unmatchedId, resolvedAt: null },
      data: { resolvedAt: new Date(), resolvedBy: user, resolution: `dismissed: ${why}` },
    });
    if (n.count !== 1) throw new WorkflowRejected({ code: 'INVALID_STATE', detail: 'already resolved or not found' });
    await appendAudit(tx, { actor: user, action: 'unmatched.dismiss', entityType: 'unmatched_result', entityId: unmatchedId, reason: why });
  });
}

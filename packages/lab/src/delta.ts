import type { ResultValue } from '@lis/contracts';
import { uuidv7, type Db } from '@lis/db';
import { evaluateDelta, parseDeltaRule, type DeltaOutcome, type DeltaRuleInput } from '@lis/domain';
import { appendAudit } from './audit.js';
import { InvalidInput } from './instruments.js';
import { WorkflowRejected } from './results.js';
import type { Tx } from './tx.js';

/**
 * Delta check (08 §12, A-20). The previous value is the selected version of
 * the patient's most recent other result for the same test that a person (or
 * autoverification) approved, collected inside the rule's window before this
 * specimen. Results still waiting for review are not compared against.
 */
const APPROVED = ['approved', 'queued', 'sent', 'hmis_confirmed', 'failed', 'corrected'];

export async function deltaFor(tx: Tx, resultId: string, value: ResultValue, units: string | undefined | null): Promise<DeltaOutcome | null> {
  if (value.kind !== 'numeric') return null;
  const r = await tx.result.findUniqueOrThrow({ where: { id: resultId }, select: { orderedTest: { select: { localTestCode: true, specimen: { select: { collectedAt: true } }, order: { select: { patientId: true } } } } } });
  const t = r.orderedTest;
  if (!t.localTestCode) return null;
  const rule = await tx.deltaRule.findFirst({ where: { localTestCode: t.localTestCode, active: true } });
  if (!rule) return null;
  const at = t.specimen?.collectedAt ?? new Date();
  const from = new Date(at.getTime() - rule.windowDays * 86_400_000);
  const rows = await tx.$queryRaw<{ resultId: string; value: ResultValue; units: string | null; collectedAt: Date }[]>`
    SELECT r.id AS "resultId", v.value, v.units, COALESCE(s.collected_at, v.created_at) AS "collectedAt"
      FROM result r
      JOIN result_version v ON v.result_id = r.id AND v.version_no = r.selected_version_no
      JOIN ordered_test t ON t.id = r.ordered_test_id
      JOIN lab_order o ON o.id = t.order_id
      LEFT JOIN specimen s ON s.id = t.specimen_id
     WHERE o.patient_id = ${t.order.patientId}::uuid
       AND t.local_test_code = ${t.localTestCode}
       AND r.id <> ${resultId}::uuid
       AND r.status = ANY(${APPROVED})
       AND COALESCE(s.collected_at, v.created_at) BETWEEN ${from} AND ${at}
     ORDER BY 4 DESC
     LIMIT 1`;
  return evaluateDelta(value, units, rule, rows[0] ?? null);
}

/** The result_version columns for a delta outcome. */
export const deltaColumns = (d: DeltaOutcome | null) => ({
  deltaFlag: d?.flag ?? null,
  deltaRuleId: d?.ruleId ?? null,
  deltaPreviousResultId: d?.previousResultId ?? null,
  deltaDetail: d?.detail ?? null,
});

export async function addDeltaRule(db: Db, actor: string, input: DeltaRuleInput): Promise<string> {
  const p = parseDeltaRule(input);
  if (!p.ok) throw new InvalidInput(p.issues);
  const id = uuidv7();
  await db.$transaction(async (tx) => {
    if (await tx.deltaRule.findFirst({ where: { localTestCode: p.value.localTestCode, active: true } })) {
      throw new InvalidInput([`${p.value.localTestCode} already has an active delta rule. Retire it first.`]);
    }
    await tx.deltaRule.create({ data: { id, ...p.value, createdBy: actor } });
    await appendAudit(tx, { actor, action: 'delta-rule.add', entityType: 'delta_rule', entityId: id, after: p.value });
  });
  return id;
}

export async function retireDeltaRule(db: Db, actor: string, id: string, reason: string): Promise<void> {
  if (reason.trim().length < 5) throw new InvalidInput(['Give a reason of at least 5 characters.']);
  await db.$transaction(async (tx) => {
    const n = await tx.deltaRule.updateMany({ where: { id, active: true }, data: { active: false, retiredBy: actor, retiredAt: new Date(), retireReason: reason.trim() } });
    if (n.count !== 1) throw new WorkflowRejected({ code: 'INVALID_STATE', detail: 'that rule is not active' });
    await appendAudit(tx, { actor, action: 'delta-rule.retire', entityType: 'delta_rule', entityId: id, reason: reason.trim() });
  });
}

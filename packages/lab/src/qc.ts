import type { ResultValue } from '@lis/contracts';
import { uuidv7, type Db, type JsonInput } from '@lis/db';
import { evaluateQc, evaluateWestgard, parseQcRange, qcSupports, westgardHistory, WESTGARD_RUN_RULES, zScore, type QcControl, type QcOutcome, type QcOutcomeKind, type QcRangeInput, type WestgardRule } from '@lis/domain';
import { appendAudit } from './audit.js';
import { InvalidInput } from './instruments.js';
import { WorkflowRejected } from './results.js';
import type { Tx } from './tx.js';

/**
 * QC log (08 §12, A-21). Each QC observation is checked once, inside the
 * intake transaction, against the lab's active ranges for that instrument
 * and test, and the outcome is kept. When the range has a target mean and
 * SD, the z score is kept too, and the lab's chosen Westgard rules are
 * checked against that control's earlier accepted results (A-23). Nothing
 * here changes patient results.
 */
export async function evaluateQcMessage(tx: Tx, normalizedMessageId: string): Promise<number> {
  const nm = await tx.normalizedMessage.findUniqueOrThrow({ where: { id: normalizedMessageId }, include: { observations: { orderBy: { seq: 'asc' } } } });
  const payload = nm.payload as { qc?: QcControl } | null;
  const control: QcControl = payload?.qc ?? {};
  let n = 0;
  for (const o of nm.observations) {
    const ranges = o.localTestCode ? await tx.qcRange.findMany({ where: { instrumentId: nm.instrumentId, localTestCode: o.localTestCode, active: true } }) : [];
    const value = o.value as unknown as ResultValue;
    let r: QcOutcome = o.localTestCode
      ? evaluateQc(value, o.units, ranges, control)
      : { outcome: 'NO_RANGE' as const, rangeId: null, detail: `instrument test ${o.instrumentTestCode} is not mapped to a lab test` };
    let z: number | null = null;
    let reject: WestgardRule[] = [];
    let warn: WestgardRule[] = [];
    const range = ranges.find((x) => x.id === r.rangeId);
    if (range?.targetMean && range.targetSd && value.kind === 'numeric' && (r.outcome === 'IN_RANGE' || r.outcome === 'OUT_OF_RANGE')) {
      z = zScore(value.value, range.targetMean, range.targetSd);
      const rules = range.westgardRules as WestgardRule[];
      const need = westgardHistory(rules);
      const earlier = need
        ? await tx.qcEvaluation.findMany({ where: { rangeId: range.id, outcome: 'IN_RANGE', zScore: { not: null } }, orderBy: [{ at: 'desc' }, { id: 'desc' }], take: need, select: { zScore: true } })
        : [];
      // R-4s and 2-2s within the run (A-38, A-40): the other controls of this test on this instrument within the range's run window.
      const peers = rules.some((x) => WESTGARD_RUN_RULES.includes(x)) && range.runMinutes
        ? await tx.qcEvaluation.findMany({
            where: { instrumentId: nm.instrumentId, localTestCode: o.localTestCode, rangeId: { not: range.id }, zScore: { not: null }, at: { gte: new Date(Date.now() - range.runMinutes * 60_000) } },
            select: { zScore: true },
          })
        : [];
      ({ reject, warn } = evaluateWestgard(z, earlier.map((e) => e.zScore as number), rules, peers.map((p) => p.zScore as number)));
      const note = [reject.length ? `breaks ${reject.join(', ')}` : '', warn.length ? `warning ${warn.join(', ')}` : ''].filter(Boolean).join('; ');
      const detail = `${r.detail}, z ${z.toFixed(2)}${note ? `; ${note}` : ''}`;
      r = { ...r, outcome: r.outcome === 'IN_RANGE' && reject.length ? 'RULE_VIOLATION' : r.outcome, detail };
    }
    await tx.qcEvaluation.create({
      data: {
        id: uuidv7(), observationId: o.id, instrumentId: nm.instrumentId, localTestCode: o.localTestCode,
        controlLot: control.lot ?? null, controlName: control.controlName ?? null, controlLevel: control.level ?? null,
        value: o.value as JsonInput, units: o.units, rangeId: r.rangeId, outcome: r.outcome, detail: r.detail,
        zScore: z, westgardReject: reject, westgardWarn: warn,
      },
    });
    n++;
  }
  return n;
}

/** For autoverification: QC for this test on this instrument within the window. */
export async function qcCheckFor(tx: Tx | Db, instrumentId: string, localTestCode: string, hours: number, now = new Date()): Promise<{ ok: boolean; detail: string }> {
  const since = new Date(now.getTime() - hours * 3_600_000);
  const evals = await tx.qcEvaluation.findMany({ where: { instrumentId, localTestCode, at: { gte: since, lte: now } }, select: { rangeId: true, outcome: true, at: true } });
  return qcSupports(evals.map((e) => ({ ...e, outcome: e.outcome as QcOutcomeKind })), hours);
}

export interface FailingQc {
  instrumentId: string;
  instrumentName: string;
  localTestCode: string;
  controlLot: string | null;
  controlName: string | null;
  outcome: string;
  detail: string;
  at: Date;
}

/** Active ranges whose latest QC result failed (out of range, a Westgard rejection, other units), oldest first. */
export async function failingQc(db: Db | Tx): Promise<FailingQc[]> {
  return db.$queryRaw<FailingQc[]>`
    SELECT l."instrumentId", i.display_name AS "instrumentName", l."localTestCode", l."controlLot", l."controlName", l.outcome, l.detail, l.at
      FROM (
        SELECT DISTINCT ON (e.range_id) e.range_id, e.instrument_id AS "instrumentId", e.local_test_code AS "localTestCode",
               e.control_lot AS "controlLot", e.control_name AS "controlName", e.outcome, e.detail, e.at
          FROM qc_evaluation e
          JOIN qc_range r ON r.id = e.range_id AND r.active
         ORDER BY e.range_id, e.at DESC, e.id DESC
      ) l
      JOIN instrument i ON i.id = l."instrumentId"
     WHERE l.outcome IN ('OUT_OF_RANGE', 'RULE_VIOLATION', 'UNITS_DIFFER')
     ORDER BY l.at ASC`;
}

export async function addQcRange(db: Db, actor: string, input: QcRangeInput): Promise<string> {
  const p = parseQcRange(input);
  if (!p.ok) throw new InvalidInput(p.issues);
  const id = uuidv7();
  await db.$transaction(async (tx) => {
    if (!(await tx.instrument.findUnique({ where: { id: p.value.instrumentId } }))) throw new InvalidInput(['Choose the instrument.']);
    const clash = await tx.qcRange.findFirst({ where: { instrumentId: p.value.instrumentId, localTestCode: p.value.localTestCode, controlLot: p.value.controlLot, controlName: p.value.controlName, active: true } });
    if (clash) throw new InvalidInput(['That control already has an active range on this instrument and test. Retire it first.']);
    await tx.qcRange.create({ data: { id, ...p.value, createdBy: actor } });
    await appendAudit(tx, { actor, action: 'qc-range.add', entityType: 'qc_range', entityId: id, after: p.value });
  });
  return id;
}

export async function retireQcRange(db: Db, actor: string, id: string, reason: string): Promise<void> {
  if (reason.trim().length < 5) throw new InvalidInput(['Give a reason of at least 5 characters.']);
  await db.$transaction(async (tx) => {
    const n = await tx.qcRange.updateMany({ where: { id, active: true }, data: { active: false, retiredBy: actor, retiredAt: new Date(), retireReason: reason.trim() } });
    if (n.count !== 1) throw new WorkflowRejected({ code: 'INVALID_STATE', detail: 'that range is not active' });
    await appendAudit(tx, { actor, action: 'qc-range.retire', entityType: 'qc_range', entityId: id, reason: reason.trim() });
  });
}

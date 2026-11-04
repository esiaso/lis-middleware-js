import type { ResultValue } from '@lis/contracts';
import type { Db } from '@lis/db';
import { qcStatistics, type QcStats } from '@lis/domain';
import type { Tx } from './tx.js';

/**
 * QC summary per range over a period (A-28). Counts the QC values that were
 * compared with the range (in range, out of range, or a Westgard rejection),
 * including rejected ones, so the statistics show how the control actually
 * ran. Values with other units or no number are left out and counted apart.
 */
export interface QcSummaryRow {
  rangeId: string;
  instrumentId: string;
  instrument: string;
  test: string;
  controlName: string | null;
  controlLot: string | null;
  units: string;
  low: string;
  high: string;
  targetMean: string | null;
  targetSd: string | null;
  active: boolean;
  rejected: number;
  warnings: number;
  /** Values the range could not be compared with (other units, not numeric). */
  notCompared: number;
  /** Most decimal places among the values, to show the statistics with one more. */
  places: number;
  stats: QcStats;
}

const COMPARED = ['IN_RANGE', 'OUT_OF_RANGE', 'RULE_VIOLATION'];

export async function qcSummary(db: Db | Tx, from: Date, to: Date): Promise<QcSummaryRow[]> {
  const evals = await db.qcEvaluation.findMany({
    where: { rangeId: { not: null }, at: { gte: from, lt: to } },
    select: { rangeId: true, outcome: true, value: true, westgardWarn: true },
    orderBy: [{ at: 'asc' }, { id: 'asc' }],
  });
  const ids = [...new Set(evals.map((e) => e.rangeId as string))];
  if (!ids.length) return [];
  const ranges = await db.qcRange.findMany({ where: { id: { in: ids } }, include: { instrument: { select: { displayName: true } } } });
  const rows = ranges.map((r) => {
    const mine = evals.filter((e) => e.rangeId === r.id);
    const compared = mine.filter((e) => COMPARED.includes(e.outcome)).map((e) => e.value as unknown as ResultValue).filter((v): v is Extract<ResultValue, { kind: 'numeric' }> => v.kind === 'numeric');
    return {
      rangeId: r.id,
      instrumentId: r.instrumentId,
      instrument: r.instrument.displayName,
      test: r.localTestCode,
      controlName: r.controlName,
      controlLot: r.controlLot,
      units: r.units,
      low: r.low,
      high: r.high,
      targetMean: r.targetMean,
      targetSd: r.targetSd,
      active: r.active,
      rejected: mine.filter((e) => e.outcome === 'OUT_OF_RANGE' || e.outcome === 'RULE_VIOLATION').length,
      warnings: mine.filter((e) => e.outcome === 'IN_RANGE' && e.westgardWarn.length > 0).length,
      notCompared: mine.length - compared.length,
      places: Math.max(0, ...compared.map((v) => v.scale)),
      stats: qcStatistics(compared.map((v) => v.value), { mean: r.targetMean, sd: r.targetSd }),
    };
  });
  return rows.sort((a, b) => a.instrument.localeCompare(b.instrument) || a.test.localeCompare(b.test) || (a.controlName ?? '').localeCompare(b.controlName ?? '') || (a.controlLot ?? '').localeCompare(b.controlLot ?? ''));
}

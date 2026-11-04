import { APPROVED_STATUSES, type HistoryResult } from '@lis/lab';
import { formatTime, formatValue } from './format.js';

export interface CumulativeCell {
  href: string;
  value: string;
  units: string;
  flags: string;
  approved: boolean;
  critical: string;
  delta: boolean;
}

export interface Cumulative {
  columns: { label: string; collected: boolean }[];
  rows: { test: string; cells: CumulativeCell[][] }[];
  /** Collections not shown because only the newest `maxColumns` fit. */
  hidden: number;
}

/**
 * Lay a patient's results out as a cumulative report: one column per
 * collection time (newest first, to the minute), one row per test. Two
 * results for the same test in one collection share the cell.
 */
export function cumulative(results: HistoryResult[], maxColumns = 12): Cumulative {
  const key = (r: HistoryResult) => `${r.at.toISOString().slice(0, 16)}|${r.collected ? 'c' : 'o'}`;
  const times = [...new Map(results.map((r) => [key(r), r])).values()].sort((a, b) => b.at.getTime() - a.at.getTime());
  const shown = times.slice(0, maxColumns);
  const col = new Map(shown.map((r, i) => [key(r), i]));
  const tests = [...new Set(results.filter((r) => col.has(key(r))).map((r) => r.test))].sort();
  const rows = tests.map((test) => {
    const cells: CumulativeCell[][] = shown.map(() => []);
    for (const r of results) {
      const i = col.get(key(r));
      if (i === undefined || r.test !== test) continue;
      cells[i]!.push({
        href: `/results/${r.resultId}`,
        value: formatValue(r.value),
        units: r.units ?? '',
        flags: r.abnormalFlags.join(' '),
        approved: APPROVED_STATUSES.includes(r.status),
        critical: r.criticalFlag === 'LOW' || r.criticalFlag === 'HIGH' ? r.criticalFlag : '',
        delta: r.deltaFlag === 'EXCEEDED',
      });
    }
    return { test, cells };
  });
  return {
    columns: shown.map((r) => ({ label: formatTime(r.at), collected: r.collected })),
    rows,
    hidden: Math.max(0, times.length - shown.length),
  };
}

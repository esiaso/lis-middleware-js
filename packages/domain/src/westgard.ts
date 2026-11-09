import { compareDecimal, isDecimal } from './critical-limits.js';

/**
 * Westgard multirule checks on one control's QC series (08 §12, A-23).
 *
 * Each rule looks at a control's z score, (value - mean) / SD, with the
 * target mean and SD the lab enters for that control. The rules are the
 * published Westgard ones; which of them apply, and the mean and SD, are
 * the lab's choice. None are on by default.
 *
 * Assumptions, labelled as such in 01 A-23:
 * - Rules other than R-4s look along one control's own series (across
 *   runs). Instruments send each control as its own QC message, so there is
 *   no run in the messages; for R-4s the lab defines one per range as the
 *   other controls of the same test on the same instrument within a number
 *   of minutes (A-38).
 * - The series is the earlier results for the same range that were
 *   accepted (IN_RANGE). Results already rejected do not count again, so a
 *   rerun after corrective action starts clean, as the lab's QC procedure
 *   would expect.
 */
export const WESTGARD_RULES = ['1-2s', '1-3s', '2-2s', 'R-4s', '4-1s', '10x'] as const;
export type WestgardRule = (typeof WESTGARD_RULES)[number];

/** 1-2s is a warning in the classic multirule scheme; the others reject. */
export const WESTGARD_WARNING: readonly WestgardRule[] = ['1-2s'];

export const WESTGARD_LABEL: Record<WestgardRule, string> = {
  '1-2s': '1-2s: one result beyond 2 SD (warning)',
  '1-3s': '1-3s: one result beyond 3 SD',
  '2-2s': '2-2s: two results in a row beyond 2 SD on the same side',
  'R-4s': 'R-4s: in one run, this control beyond 2 SD and another control beyond 2 SD on the other side (needs the run window)',
  '4-1s': '4-1s: four results in a row beyond 1 SD on the same side',
  '10x': '10x: ten results in a row on the same side of the mean',
};

/** Rounded to 2 places: enough for SD multiples and stable to store. */
export function zScore(value: string, mean: string, sd: string): number {
  return Math.round(((Number(value) - Number(mean)) / Number(sd)) * 100) / 100;
}

/** Whether `n` values, starting with the current one, all lie past `limit` on one side. */
function run(zs: number[], n: number, limit: number): boolean {
  if (zs.length < n) return false;
  const s = zs.slice(0, n);
  return s.every((z) => z > limit) || s.every((z) => z < -limit);
}

/**
 * Checks the current z score with the earlier accepted ones, most recent
 * first, and for R-4s with the z scores of the other controls in the same
 * run (`runPeers`). Returns the rules broken, split into rejections and warnings.
 */
export function evaluateWestgard(z: number, earlier: number[], rules: readonly WestgardRule[], runPeers: readonly number[] = []): { reject: WestgardRule[]; warn: WestgardRule[] } {
  const zs = [z, ...earlier];
  const broken = rules.filter((r) => {
    switch (r) {
      case '1-2s': return Math.abs(z) > 2;
      case '1-3s': return Math.abs(z) > 3;
      case '2-2s': return run(zs, 2, 2);
      case 'R-4s': return (z > 2 && runPeers.some((p) => p < -2)) || (z < -2 && runPeers.some((p) => p > 2));
      case '4-1s': return run(zs, 4, 1);
      case '10x': return run(zs, 10, 0);
    }
  });
  return { reject: broken.filter((r) => !WESTGARD_WARNING.includes(r)), warn: broken.filter((r) => WESTGARD_WARNING.includes(r)) };
}

/** How many earlier results the longest chosen rule needs. */
export const westgardHistory = (rules: readonly WestgardRule[]) => (rules.includes('10x') ? 9 : rules.includes('4-1s') ? 3 : rules.includes('2-2s') ? 1 : 0);

export interface ParsedWestgard {
  targetMean: string | null;
  targetSd: string | null;
  westgardRules: WestgardRule[];
  /** For R-4s: other controls of the same test on the same instrument within this many minutes are one run. */
  runMinutes: number | null;
}

export function parseWestgard(mean: string, sd: string, rules: string[], runMinutes = ''): { ok: true; value: ParsedWestgard } | { ok: false; issues: string[] } {
  const m = mean.trim();
  const s = sd.trim();
  const chosen = [...new Set(rules.map((r) => r.trim()).filter(Boolean))];
  const issues: string[] = [];
  const unknown = chosen.filter((r) => !(WESTGARD_RULES as readonly string[]).includes(r));
  if (unknown.length) issues.push(`Unknown Westgard rule: ${unknown.join(', ')}.`);
  if (!m && !s) {
    if (chosen.length) issues.push('Westgard rules need the target mean and SD for this control.');
    return issues.length ? { ok: false, issues } : { ok: true, value: { targetMean: null, targetSd: null, westgardRules: [], runMinutes: null } };
  }
  if (!isDecimal(m)) issues.push('The target mean must be a number such as 4.5, or leave both mean and SD empty.');
  if (!isDecimal(s) || compareDecimal(s, '0') <= 0) issues.push('The target SD must be a number above 0, such as 0.12, or leave both mean and SD empty.');
  const rm = runMinutes.trim();
  const wantsRun = chosen.includes('R-4s');
  if (wantsRun && (!/^\d{1,3}$/.test(rm) || Number(rm) < 1 || Number(rm) > 240)) issues.push('R-4s needs the run window: 1 to 240 minutes within which this control and the other controls of the test count as one run.');
  if (issues.length) return { ok: false, issues };
  const order = WESTGARD_RULES.filter((r) => chosen.includes(r));
  return { ok: true, value: { targetMean: m, targetSd: s, westgardRules: order, runMinutes: wantsRun ? Number(rm) : null } };
}

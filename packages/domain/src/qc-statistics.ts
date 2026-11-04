/**
 * Summary statistics of one control's QC values over a period (A-28): the
 * observed mean, SD and CV that a lab reviews each month and uses to set or
 * check its target mean and SD. Plain arithmetic, nothing estimated.
 *
 * - SD is the sample SD (divides by n - 1), as QC practice uses; it needs
 *   at least two values.
 * - CV is SD / |mean| as a percentage; it is not given when the mean is 0.
 * - Bias is (observed mean - target mean) / target mean as a percentage,
 *   and the shift is the same difference in target SDs; both need a target.
 * - Values are decimal text; sums are done in floating point and results
 *   rounded for display, which is ample for QC review but is not exact
 *   decimal arithmetic.
 */
export interface QcStats {
  n: number;
  mean: number | null;
  sd: number | null;
  cvPercent: number | null;
  min: number | null;
  max: number | null;
  biasPercent: number | null;
  shiftSd: number | null;
}

const round = (x: number, places: number) => {
  const f = 10 ** places;
  return Math.round(x * f) / f;
};

export function qcStatistics(values: readonly string[], target: { mean: string | null; sd: string | null } = { mean: null, sd: null }): QcStats {
  const xs = values.map(Number).filter((x) => Number.isFinite(x));
  const n = xs.length;
  if (!n) return { n: 0, mean: null, sd: null, cvPercent: null, min: null, max: null, biasPercent: null, shiftSd: null };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1)) : null;
  const tm = target.mean === null ? null : Number(target.mean);
  const ts = target.sd === null ? null : Number(target.sd);
  return {
    n,
    mean: round(mean, 6),
    sd: sd === null ? null : round(sd, 6),
    cvPercent: sd !== null && mean !== 0 ? round((sd / Math.abs(mean)) * 100, 2) : null,
    min: Math.min(...xs),
    max: Math.max(...xs),
    biasPercent: tm !== null && tm !== 0 ? round(((mean - tm) / Math.abs(tm)) * 100, 2) : null,
    shiftSd: tm !== null && ts !== null && ts > 0 ? round((mean - tm) / ts, 2) : null,
  };
}

/** A number shown with `places` decimals, or empty. */
export function formatStat(x: number | null, places: number): string {
  return x === null ? '' : x.toFixed(places);
}

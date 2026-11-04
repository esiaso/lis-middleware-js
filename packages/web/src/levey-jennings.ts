/**
 * Levey-Jennings chart geometry for one QC range (W-15). Pure: the page
 * draws it as inline SVG, so no script is needed (CSP script-src 'self').
 *
 * The axis is in the control's own units. With a target mean and SD it
 * spans mean ± 4 SD (widened to take in the acceptable range) and draws
 * lines at the mean and ±1, ±2, ±3 SD; without them it spans the range
 * with a margin and draws only the range limits. Points beyond the axis
 * are pinned to its edge and marked, never dropped.
 */
export interface LjInputPoint {
  value: number;
  at: string;
  outcome: string;
  /** Text for the point's tooltip and the table. */
  label: string;
}

export interface LjRange {
  low: number;
  high: number;
  mean: number | null;
  sd: number | null;
}

export interface LjLine { y: number; label: string; kind: 'mean' | 'sd1' | 'sd2' | 'sd3' | 'limit' }
export interface LjPoint { x: number; y: number; cls: string; title: string; clipped: 'above' | 'below' | null }

export interface LjChart {
  width: number;
  height: number;
  left: number;
  right: number;
  lines: LjLine[];
  points: LjPoint[];
  path: string;
}

const W = 720;
const H = 300;
const LEFT = 70;
const RIGHT = 10;
const TOP = 10;
const BOTTOM = 10;

const fmt = (n: number) => String(Math.round(n * 1e6) / 1e6);

export function leveyJennings(range: LjRange, points: LjInputPoint[]): LjChart {
  const hasTarget = range.mean !== null && range.sd !== null && range.sd > 0;
  let min: number;
  let max: number;
  if (hasTarget) {
    const m = range.mean as number;
    const s = range.sd as number;
    min = Math.min(m - 4 * s, range.low);
    max = Math.max(m + 4 * s, range.high);
  } else {
    const pad = (range.high - range.low) * 0.25 || Math.abs(range.high) * 0.1 || 1;
    min = range.low - pad;
    max = range.high + pad;
  }
  const y = (v: number) => Math.round((TOP + ((max - v) / (max - min)) * (H - TOP - BOTTOM)) * 10) / 10;
  const lines: LjLine[] = [
    { y: y(range.low), label: `low ${fmt(range.low)}`, kind: 'limit' },
    { y: y(range.high), label: `high ${fmt(range.high)}`, kind: 'limit' },
  ];
  if (hasTarget) {
    const m = range.mean as number;
    const s = range.sd as number;
    lines.push({ y: y(m), label: `mean ${fmt(m)}`, kind: 'mean' });
    for (const k of [1, 2, 3] as const) {
      lines.push({ y: y(m + k * s), label: `+${k} SD`, kind: `sd${k}` });
      lines.push({ y: y(m - k * s), label: `-${k} SD`, kind: `sd${k}` });
    }
  }
  const n = points.length;
  const span = W - LEFT - RIGHT;
  const out: LjPoint[] = points.map((p, i) => {
    const clipped = p.value > max ? 'above' : p.value < min ? 'below' : null;
    const v = clipped === 'above' ? max : clipped === 'below' ? min : p.value;
    const x = Math.round((LEFT + (n === 1 ? span / 2 : (i * span) / (n - 1))) * 10) / 10;
    const cls = p.outcome === 'IN_RANGE' ? 'lj-ok' : p.outcome === 'RULE_VIOLATION' ? 'lj-rule' : 'lj-bad';
    return { x, y: y(v), cls, title: `${p.at}: ${p.label}`, clipped };
  });
  const path = out.map((p, i) => `${i ? 'L' : 'M'}${p.x} ${p.y}`).join(' ');
  return { width: W, height: H, left: LEFT, right: W - RIGHT, lines, points: out, path };
}

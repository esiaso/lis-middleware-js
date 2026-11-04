import { describe, expect, it } from 'vitest';
import { parseTatFilter, summarizeTat, type TatResultTimes } from '../src/tat.js';

const t = (h: number, m = 0) => new Date(Date.UTC(2026, 10, 3, h, m));
const row = (over: Partial<TatResultTimes>): TatResultTimes => ({
  accessionNo: 'L1', test: 'K', priority: 'routine', ordered: null, collected: null, received: null, first_value: null, approved: null, approvedBy: null, released: null, accepted: null, ...over,
});

describe('summarizeTat', () => {
  it('gives median and 90th percentile per step, per test and overall', () => {
    const rows = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((min, i) => row({ test: i < 8 ? 'K' : 'NA', collected: t(8), received: t(8, min) }));
    const s = summarizeTat(rows);
    expect(s.all.results).toBe(10);
    expect(s.all.steps.collected_received).toEqual({ n: 10, median: 50 * 60, p90: 90 * 60, negative: 0 });
    expect(s.tests.map((r) => [r.test, r.steps.collected_received.median])).toEqual([['K', 40 * 60], ['NA', 90 * 60]]);
    expect(s.all.steps.received_first).toEqual({ n: 0, median: null, p90: null, negative: 0 });
  });

  it('leaves out missing and backwards times, counting the backwards ones', () => {
    const s = summarizeTat([row({ collected: t(9), received: t(8) }), row({ collected: t(8), received: t(8, 30), accepted: t(10) }), row({ received: t(8) })]);
    expect(s.all.steps.collected_received).toEqual({ n: 1, median: 1800, p90: 1800, negative: 1 });
    expect(s.all.steps.collected_accepted).toMatchObject({ n: 1, median: 7200 });
  });
});

describe('parseTatFilter', () => {
  const now = new Date('2026-11-04T15:00:00Z');
  it('defaults to the last 7 days including today, in UTC', () => {
    expect(parseTatFilter({}, now)).toEqual({ from: new Date('2026-10-29T00:00:00Z'), to: new Date('2026-11-05T00:00:00Z'), priority: null });
  });
  it('includes both days, and checks the input', () => {
    expect(parseTatFilter({ from: '2026-11-01', to: '2026-11-01', priority: 'stat' }, now)).toEqual({ from: new Date('2026-11-01T00:00:00Z'), to: new Date('2026-11-02T00:00:00Z'), priority: 'stat' });
    expect(parseTatFilter({ priority: 'anything' }, now).priority).toBeNull();
    expect(() => parseTatFilter({ from: '1/11/2026' }, now)).toThrow();
    expect(() => parseTatFilter({ from: '2026-11-03', to: '2026-11-01' }, now)).toThrow();
    expect(() => parseTatFilter({ from: '2025-01-01', to: '2026-11-01' }, now)).toThrow();
  });
});

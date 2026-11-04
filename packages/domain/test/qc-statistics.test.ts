import { describe, expect, it } from 'vitest';
import { formatStat, qcStatistics } from '../src/qc-statistics.js';

describe('qcStatistics', () => {
  it('gives the observed mean, sample SD and CV', () => {
    const s = qcStatistics(['4.0', '4.2', '4.4', '4.6', '4.8']);
    expect(s.n).toBe(5);
    expect(s.mean).toBe(4.4);
    expect(s.sd).toBeCloseTo(0.316228, 6); // sqrt(0.4 / 4)
    expect(s.cvPercent).toBe(7.19);
    expect([s.min, s.max]).toEqual([4, 4.8]);
    expect([s.biasPercent, s.shiftSd]).toEqual([null, null]);
  });

  it('compares with the target when the range has one', () => {
    const s = qcStatistics(['4.0', '4.2', '4.4', '4.6', '4.8'], { mean: '4.0', sd: '0.2' });
    expect(s.biasPercent).toBe(10);
    expect(s.shiftSd).toBe(2);
  });

  it('needs two values for an SD and a non-zero mean for a CV', () => {
    expect(qcStatistics(['5.1'])).toMatchObject({ n: 1, mean: 5.1, sd: null, cvPercent: null });
    expect(qcStatistics(['-1', '1'])).toMatchObject({ mean: 0, cvPercent: null });
    expect(qcStatistics([])).toMatchObject({ n: 0, mean: null });
    expect(qcStatistics(['1', '2'], { mean: '0', sd: '1' })).toMatchObject({ biasPercent: null, shiftSd: 1.5 });
  });

  it('formats for display', () => {
    expect(formatStat(4.4, 3)).toBe('4.400');
    expect(formatStat(null, 2)).toBe('');
  });
});

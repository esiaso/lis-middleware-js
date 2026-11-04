import { describe, expect, it } from 'vitest';
import { evaluateWestgard, parseQcRange, parseWestgard, westgardHistory, zScore, WESTGARD_RULES } from '../src/index.js';

// Means and SDs here are made up for the tests. They are not from any control insert.
describe('Westgard rules', () => {
  const all = WESTGARD_RULES;
  it('scores against the target mean and SD', () => {
    expect(zScore('4.73', '4.5', '0.1')).toBe(2.3);
    expect(zScore('4.2', '4.5', '0.1')).toBe(-3);
  });

  it('treats 1-2s as a warning and the rest as rejections', () => {
    expect(evaluateWestgard(2.1, [], all)).toEqual({ reject: [], warn: ['1-2s'] });
    expect(evaluateWestgard(-3.1, [], all)).toEqual({ reject: ['1-3s'], warn: ['1-2s'] });
    expect(evaluateWestgard(3, [], all)).toEqual({ reject: [], warn: ['1-2s'] }); // exactly 3 SD is not beyond it
  });

  it('needs consecutive results on the same side', () => {
    expect(evaluateWestgard(2.1, [2.4], all).reject).toEqual(['2-2s']);
    expect(evaluateWestgard(2.1, [-2.4], all).reject).toEqual([]);
    expect(evaluateWestgard(1.2, [1.1, 1.5, 1.01], all).reject).toEqual(['4-1s']);
    expect(evaluateWestgard(1.2, [1.1, 0.9, 1.5], all).reject).toEqual([]);
    expect(evaluateWestgard(0.1, [0.2, 0.3, 0.1, 0.5, 0.4, 0.2, 0.1, 0.3, 0.2], all).reject).toEqual(['10x']);
    expect(evaluateWestgard(0.1, [0.2, 0.3, 0.1, 0, 0.4, 0.2, 0.1, 0.3, 0.2], all).reject).toEqual([]);
    expect(evaluateWestgard(0.1, [0.2, 0.3], all).reject).toEqual([]); // too few results yet
  });

  it('applies only the rules the lab chose', () => {
    expect(evaluateWestgard(3.5, [2.5], ['10x'])).toEqual({ reject: [], warn: [] });
    expect(westgardHistory([])).toBe(0);
    expect(westgardHistory(['1-3s', '2-2s'])).toBe(1);
    expect(westgardHistory(['4-1s'])).toBe(3);
    expect(westgardHistory(['10x', '2-2s'])).toBe(9);
  });

  it('checks the mean, SD and rules a person enters', () => {
    expect(parseWestgard('', '', [])).toEqual({ ok: true, value: { targetMean: null, targetSd: null, westgardRules: [] } });
    expect(parseWestgard('4.5', '0.1', ['2-2s', '1-3s', '2-2s'])).toEqual({ ok: true, value: { targetMean: '4.5', targetSd: '0.1', westgardRules: ['1-3s', '2-2s'] } });
    expect(parseWestgard('', '', ['1-3s'])).toMatchObject({ ok: false, issues: ['Westgard rules need the target mean and SD for this control.'] });
    expect(parseWestgard('4.5', '0', [])).toMatchObject({ ok: false });
    expect(parseWestgard('4.5', '', [])).toMatchObject({ ok: false });
    expect(parseWestgard('4.5', '0.1', ['R-4s'])).toMatchObject({ ok: false, issues: ['Unknown Westgard rule: R-4s.'] });
    const base = { instrumentId: 'i', localTestCode: 'K', controlLot: 'L1', controlName: '', low: '4.1', high: '4.9', units: 'mmol/L', reference: 'QC plan v1' };
    expect(parseQcRange(base)).toMatchObject({ ok: true, value: { targetMean: null, westgardRules: [] } });
    expect(parseQcRange({ ...base, targetMean: '4.5', targetSd: '0.1', westgardRules: ['1-3s'] })).toMatchObject({ ok: true, value: { targetSd: '0.1', westgardRules: ['1-3s'] } });
  });
});

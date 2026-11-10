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

  it('R-4s needs another control in the run beyond 2 SD on the other side (A-38)', () => {
    expect(evaluateWestgard(2.3, [], ['R-4s'], [-2.1])).toEqual({ reject: ['R-4s'], warn: [] });
    expect(evaluateWestgard(-2.5, [], ['R-4s'], [0.4, 2.2])).toEqual({ reject: ['R-4s'], warn: [] });
    expect(evaluateWestgard(2.3, [], ['R-4s'], [2.4])).toEqual({ reject: [], warn: [] }); // same side: not R-4s
    expect(evaluateWestgard(2.3, [], ['R-4s'], [-1.9])).toEqual({ reject: [], warn: [] });
    expect(evaluateWestgard(1.9, [], ['R-4s'], [-2.5])).toEqual({ reject: [], warn: [] });
    expect(evaluateWestgard(2.3, [], ['R-4s'])).toEqual({ reject: [], warn: [] }); // no other control in the run
  });

  it('2-2s within the run needs another control in the run beyond 2 SD on the same side (A-40)', () => {
    expect(evaluateWestgard(2.3, [], ['2-2s-run'], [2.1])).toEqual({ reject: ['2-2s-run'], warn: [] });
    expect(evaluateWestgard(-2.5, [], ['2-2s-run'], [0.4, -2.2])).toEqual({ reject: ['2-2s-run'], warn: [] });
    expect(evaluateWestgard(2.3, [], ['2-2s-run'], [-2.4])).toEqual({ reject: [], warn: [] }); // other side: R-4s, not this rule
    expect(evaluateWestgard(2.3, [], ['2-2s-run'], [1.9])).toEqual({ reject: [], warn: [] });
    expect(evaluateWestgard(1.9, [], ['2-2s-run'], [2.5])).toEqual({ reject: [], warn: [] });
    expect(evaluateWestgard(2.3, [2.4], ['2-2s-run'])).toEqual({ reject: [], warn: [] }); // the control's own series is 2-2s, not this rule
    expect(evaluateWestgard(2.3, [], ['2-2s-run', 'R-4s'], [2.1, -2.2])).toEqual({ reject: ['2-2s-run', 'R-4s'], warn: [] });
  });

  it('applies only the rules the lab chose', () => {
    expect(evaluateWestgard(3.5, [2.5], ['10x'])).toEqual({ reject: [], warn: [] });
    expect(westgardHistory([])).toBe(0);
    expect(westgardHistory(['1-3s', '2-2s'])).toBe(1);
    expect(westgardHistory(['4-1s'])).toBe(3);
    expect(westgardHistory(['10x', '2-2s'])).toBe(9);
  });

  it('checks the mean, SD and rules a person enters', () => {
    expect(parseWestgard('', '', [])).toEqual({ ok: true, value: { targetMean: null, targetSd: null, westgardRules: [], runMinutes: null } });
    expect(parseWestgard('4.5', '0.1', ['2-2s', '1-3s', '2-2s'])).toEqual({ ok: true, value: { targetMean: '4.5', targetSd: '0.1', westgardRules: ['1-3s', '2-2s'], runMinutes: null } });
    expect(parseWestgard('', '', ['1-3s'])).toMatchObject({ ok: false, issues: ['Westgard rules need the target mean and SD for this control.'] });
    expect(parseWestgard('4.5', '0', [])).toMatchObject({ ok: false });
    expect(parseWestgard('4.5', '', [])).toMatchObject({ ok: false });
    expect(parseWestgard('4.5', '0.1', ['R-4s'])).toMatchObject({ ok: false, issues: ['R-4s needs the run window: 1 to 240 minutes within which this control and the other controls of the test count as one run.'] });
    expect(parseWestgard('4.5', '0.1', ['R-4s'], '241')).toMatchObject({ ok: false });
    expect(parseWestgard('4.5', '0.1', ['R-4s', '1-3s'], '30')).toEqual({ ok: true, value: { targetMean: '4.5', targetSd: '0.1', westgardRules: ['1-3s', 'R-4s'], runMinutes: 30 } });
    expect(parseWestgard('4.5', '0.1', ['2-2s-run'])).toMatchObject({ ok: false, issues: ['2-2s-run needs the run window: 1 to 240 minutes within which this control and the other controls of the test count as one run.'] });
    expect(parseWestgard('4.5', '0.1', ['R-4s', '2-2s-run'])).toMatchObject({ ok: false, issues: ['2-2s-run and R-4s need the run window: 1 to 240 minutes within which this control and the other controls of the test count as one run.'] });
    expect(parseWestgard('4.5', '0.1', ['2-2s-run', '2-2s'], '20')).toEqual({ ok: true, value: { targetMean: '4.5', targetSd: '0.1', westgardRules: ['2-2s', '2-2s-run'], runMinutes: 20 } });
    // A run window without a within-run rule is not kept.
    expect(parseWestgard('4.5', '0.1', ['1-3s'], '30')).toMatchObject({ ok: true, value: { runMinutes: null } });
    expect(parseWestgard('4.5', '0.1', ['R-5s'])).toMatchObject({ ok: false, issues: ['Unknown Westgard rule: R-5s.'] });
    const base = { instrumentId: 'i', localTestCode: 'K', controlLot: 'L1', controlName: '', low: '4.1', high: '4.9', units: 'mmol/L', reference: 'QC plan v1' };
    expect(parseQcRange(base)).toMatchObject({ ok: true, value: { targetMean: null, westgardRules: [] } });
    expect(parseQcRange({ ...base, targetMean: '4.5', targetSd: '0.1', westgardRules: ['1-3s'] })).toMatchObject({ ok: true, value: { targetSd: '0.1', westgardRules: ['1-3s'] } });
  });
});

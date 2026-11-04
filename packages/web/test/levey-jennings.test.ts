import { describe, expect, it } from 'vitest';
import { leveyJennings } from '../src/levey-jennings.js';

// Values are made up for the tests. They are not from any control insert.
const pt = (value: number, outcome = 'IN_RANGE') => ({ value, at: 't', outcome, label: String(value) });

describe('leveyJennings', () => {
  it('spans mean ± 4 SD and draws the mean, SD lines and limits', () => {
    const c = leveyJennings({ low: 4.1, high: 4.9, mean: 4.5, sd: 0.1 }, [pt(4.5), pt(4.7, 'RULE_VIOLATION')]);
    expect(c.lines.map((l) => l.label)).toEqual(['low 4.1', 'high 4.9', 'mean 4.5', '+1 SD', '-1 SD', '+2 SD', '-2 SD', '+3 SD', '-3 SD']);
    const mean = c.lines.find((l) => l.kind === 'mean')!;
    expect(mean.y).toBe(150); // the middle of 10..290
    expect(c.points.map((p) => [p.x, p.y, p.cls])).toEqual([[70, 150], [710, 80]].map(([x, y], i) => [x, y, i ? 'lj-rule' : 'lj-ok']));
    expect(c.path).toBe('M70 150 L710 80');
  });

  it('widens the axis to the acceptable range, and pins points beyond it', () => {
    const c = leveyJennings({ low: 3, high: 6, mean: 4.5, sd: 0.1 }, [pt(9, 'OUT_OF_RANGE'), pt(-1, 'OUT_OF_RANGE')]);
    expect(c.lines.find((l) => l.label === 'high 6')!.y).toBe(10);
    expect(c.lines.find((l) => l.label === 'low 3')!.y).toBe(290);
    expect(c.points.map((p) => [p.y, p.clipped, p.cls])).toEqual([[10, 'above', 'lj-bad'], [290, 'below', 'lj-bad']]);
  });

  it('without a target, shows only the limits with a margin', () => {
    const c = leveyJennings({ low: 4, high: 6, mean: null, sd: null }, [pt(5)]);
    expect(c.lines.map((l) => [l.label, l.y])).toEqual([['low 4', 243.3], ['high 6', 56.7]]);
    expect(c.points[0]).toMatchObject({ x: 390, y: 150, clipped: null });
  });
});

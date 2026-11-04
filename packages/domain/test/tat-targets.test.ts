import { describe, expect, it } from 'vitest';
import { parseTatTarget, targetFor, type TatTarget } from '../src/index.js';

const T = (id: string, localTestCode: string | null, priority: string | null, minutes = 60): TatTarget => ({ id, localTestCode, priority, minutes });

describe('targetFor', () => {
  it('picks the most specific target', () => {
    const all = [T('any', null, null), T('stat', null, 'stat'), T('k', 'K', null), T('k-stat', 'K', 'stat')];
    expect(targetFor(all, 'K', 'stat')?.id).toBe('k-stat');
    expect(targetFor(all, 'K', 'routine')?.id).toBe('k');
    expect(targetFor(all, 'NA', 'stat')?.id).toBe('stat');
    expect(targetFor(all, 'NA', 'routine')?.id).toBe('any');
    expect(targetFor([T('k', 'K', null)], 'NA', 'routine')).toBeNull();
  });
});

describe('parseTatTarget', () => {
  it('accepts a target for every test or one test', () => {
    expect(parseTatTarget({ localTestCode: '', priority: 'stat', minutes: '60', reference: 'Lab policy TAT-01 v2' })).toEqual({ ok: true, value: { localTestCode: null, priority: 'stat', minutes: 60, reference: 'Lab policy TAT-01 v2' } });
    expect(parseTatTarget({ localTestCode: 'K', priority: '', minutes: '240', reference: 'Lab policy TAT-01 v2' }).ok).toBe(true);
  });
  it('explains every problem', () => {
    const r = parseTatTarget({ localTestCode: '', priority: 'asap', minutes: '0', reference: 'x' });
    expect(!r.ok && r.issues.length).toBe(3);
  });
});

import { describe, expect, it } from 'vitest';
import { pageParam, pagerFor, pageWindow } from '../src/paging.js';

describe('paging', () => {
  it('reads the page asked for, and anything odd is page 1', () => {
    expect(pageParam('3')).toBe(3);
    expect(pageParam('0')).toBe(1);
    expect(pageParam('-2')).toBe(1);
    expect(pageParam('x')).toBe(1);
    expect(pageParam(undefined)).toBe(1);
  });

  it('never shows a page past the last', () => {
    expect(pageWindow(9, 120, 50)).toEqual({ page: 3, skip: 100 });
    expect(pageWindow(1, 0, 50)).toEqual({ page: 1, skip: 0 });
  });

  it('keeps the list filters on every link and marks gaps', () => {
    const p = pagerFor('/results', { status: 'received', q: 'MRN 1', empty: '' }, 5, 1000, 50);
    expect(p).toMatchObject({ page: 5, pages: 20, from: 201, to: 250 });
    expect(p.prev).toBe('/results?status=received&q=MRN+1&page=4');
    expect(p.links.map((l) => l.n)).toEqual([1, 3, 4, 5, 6, 7, 20]);
    expect(p.links.filter((l) => l.gap).map((l) => l.n)).toEqual([3, 20]);
    expect(pagerFor('/orders', {}, 1, 10, 50)).toMatchObject({ prev: '', next: '', pages: 1 });
    expect(pagerFor('/orders', {}, 2, 60, 50).links[0]!.href).toBe('/orders');
  });
});

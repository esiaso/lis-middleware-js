import { describe, expect, it } from 'vitest';
import { crumbsFor } from '../src/crumbs.js';

describe('crumbsFor', () => {
  it('has no breadcrumbs on the dashboard', () => {
    expect(crumbsFor('/', {})).toEqual([]);
  });

  it('starts every other page at the dashboard', () => {
    expect(crumbsFor('/orders', {})).toEqual([{ href: '/', label: 'Dashboard' }]);
  });

  it('puts a result under Results', () => {
    expect(crumbsFor('/results/abc', {}).map((c) => c.href)).toEqual(['/', '/results']);
  });

  it('puts a specimen under its order', () => {
    const crumbs = crumbsFor('/specimens/s1', { s: { orderId: 'o1', hmisOrderId: 'HM-9' } });
    expect(crumbs.at(-1)).toEqual({ href: '/orders/o1', label: 'Order HM-9' });
  });

  it('puts a specimen label under the order and the specimen', () => {
    const crumbs = crumbsFor('/specimens/s1/label', { s: { orderId: 'o1', hmisOrderId: 'HM-9' } });
    expect(crumbs.map((c) => c.href)).toEqual(['/', '/orders', '/orders/o1', '/specimens/s1']);
  });

  it('names the order above its report', () => {
    expect(crumbsFor('/orders/o1/report', { o: { hmisOrderId: 'ORD-1' } }).at(-1)).toEqual({ href: '/orders/o1', label: 'Order ORD-1' });
  });

  it('puts a QC chart under QC ranges', () => {
    expect(crumbsFor('/qc/ranges/r1/chart', {}).map((c) => c.href)).toEqual(['/', '/qc', '/qc/ranges']);
  });

  it('puts instrument editing under the instrument', () => {
    expect(crumbsFor('/instruments/e411-1/edit', {}).at(-1)).toEqual({ href: '/instruments/e411-1', label: 'e411-1' });
  });
});

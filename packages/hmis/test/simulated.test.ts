import { describe, expect, it } from 'vitest';
import { SimulatedHmis } from '@lis/hmis';
import type { HmisResultSubmission } from '@lis/contracts';

const order = {
  hmisOrderId: 'ORD-1',
  patient: { mrn: 'MRN1' },
  orderedAt: '2026-11-03T08:15:00+03:00',
  lines: [{ hmisLineId: '1', testCode: 'TSH' }],
};
const sub = (key: string): HmisResultSubmission => ({
  idempotencyKey: key, hmisOrderId: 'ORD-1', hmisLineId: '1', testCode: 'TSH', status: 'final',
  value: { type: 'numeric', value: '1.25', unit: 'uIU/mL' }, approvedBy: { username: 'a', displayName: 'A' },
  approvedAt: '2026-11-03T10:40:00+03:00', specimen: { accessionNo: 'L1' }, comments: [], correctionOf: null,
});

describe('SimulatedHmis', () => {
  it('pages orders with a cursor', async () => {
    const h = new SimulatedHmis({ pageSize: 1 });
    h.placeOrder(order);
    h.placeOrder({ ...order, hmisOrderId: 'ORD-2' });
    const p1 = await h.pullOrders(null);
    const p2 = await h.pullOrders(p1.nextCursor);
    const p3 = await h.pullOrders(p2.nextCursor);
    expect([p1.orders[0]?.hmisOrderId, p2.orders[0]?.hmisOrderId, p3.orders.length]).toEqual(['ORD-1', 'ORD-2', 0]);
    expect(p3.nextCursor).toBe(p2.nextCursor);
  });

  it('honours idempotency keys, including after a lost response', async () => {
    const h = new SimulatedHmis();
    h.placeOrder(order);
    h.injectFault({ kind: 'lost-response' });
    expect((await h.submitResult(sub('k1'), 'k1')).kind).toBe('ambiguous');
    expect(await h.findResult({ idempotencyKey: 'k1', hmisOrderId: 'ORD-1', hmisLineId: '1' })).toMatchObject({ hmisResultId: 'HR-1' });
    expect(await h.submitResult(sub('k1'), 'k1')).toEqual({ kind: 'accepted', hmisResultId: 'HR-1' });
    expect(h.stored).toHaveLength(1);
  });

  it('can model an HMIS that ignores idempotency keys (T-20)', async () => {
    const h = new SimulatedHmis({ honourIdempotency: false });
    h.placeOrder(order);
    await h.submitResult(sub('k1'), 'k1');
    await h.submitResult(sub('k1'), 'k1');
    expect(h.stored).toHaveLength(2);
  });

  it('classifies unavailable, validation and unknown-order responses', async () => {
    const h = new SimulatedHmis();
    h.placeOrder(order);
    h.injectFault({ kind: 'unavailable', retryAfterMs: 2000 });
    expect(await h.submitResult(sub('k'), 'k')).toEqual({ kind: 'retryable', reason: '503', retryAfterMs: 2000 });
    expect((await h.submitResult({ ...sub('k'), hmisLineId: '9' }, 'k')).kind).toBe('rejected');
    expect(h.stored).toHaveLength(0);
  });
});

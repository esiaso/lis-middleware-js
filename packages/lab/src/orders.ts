import type { HmisOrder } from '@lis/contracts';
import { uuidv7, type Db, type JsonInput } from '@lis/db';
import type { HmisConnector } from '@lis/hmis';
import { appendAudit } from './audit.js';
import type { Tx } from './tx.js';

/**
 * Register one HMIS order (07 §6.3). Idempotent: the same order delivered
 * twice (webhook retry, poll overlap) changes nothing the second time.
 * HMIS test codes without a mapping are kept with localTestCode = null so
 * the order shows on the "needs attention" list rather than being dropped.
 */
export async function ingestOrder(tx: Tx, order: HmisOrder, actor = 'system:hmis'): Promise<{ orderId: string; created: boolean }> {
  const p = order.patient;
  const patient = await tx.patient.upsert({
    where: { mrn: p.mrn },
    create: {
      id: uuidv7(),
      mrn: p.mrn,
      familyName: p.familyName ?? null,
      givenName: p.givenName ?? null,
      birthDate: p.birthDate ? new Date(`${p.birthDate}T00:00:00Z`) : null,
      sex: p.sex ?? null,
    },
    update: {
      // The HMIS is the source of truth for demographics (A-5).
      familyName: p.familyName ?? null,
      givenName: p.givenName ?? null,
      birthDate: p.birthDate ? new Date(`${p.birthDate}T00:00:00Z`) : null,
      sex: p.sex ?? null,
      updatedAt: new Date(),
    },
  });

  const existing = await tx.labOrder.findUnique({ where: { hmisOrderId: order.hmisOrderId } });
  const orderId = existing?.id ?? uuidv7();
  if (!existing) {
    await tx.labOrder.create({
      data: {
        id: orderId,
        hmisOrderId: order.hmisOrderId,
        patientId: patient.id,
        hmisEncounterId: order.encounter?.hmisEncounterId ?? null,
        location: order.encounter?.location ?? null,
        priority: order.priority,
        orderedAt: new Date(order.orderedAt),
        orderingClinician: order.orderingClinician ?? null,
        status: order.status,
        sourceJson: order as unknown as JsonInput,
      },
    });
  } else if (existing.status !== order.status) {
    await tx.labOrder.update({ where: { id: orderId }, data: { status: order.status, sourceJson: order as unknown as JsonInput } });
  }

  const codes = await tx.hmisCodeMap.findMany({ where: { hmisTestCode: { in: order.lines.map((l) => l.testCode) } } });
  const local = new Map(codes.map((c) => [c.hmisTestCode, c.localTestCode]));
  for (const line of order.lines) {
    const status = order.status === 'cancelled' ? 'cancelled' : line.status;
    await tx.orderedTest.upsert({
      where: { orderId_hmisLineId: { orderId, hmisLineId: line.hmisLineId } },
      create: {
        id: uuidv7(),
        orderId,
        hmisLineId: line.hmisLineId,
        hmisTestCode: line.testCode,
        localTestCode: local.get(line.testCode) ?? null,
        specimenType: line.specimenType ?? null,
        status,
      },
      update: { status },
    });
  }
  if (!existing) {
    await appendAudit(tx, { actor, action: 'order.received', entityType: 'lab_order', entityId: orderId, after: { hmisOrderId: order.hmisOrderId, lines: order.lines.length } });
  }
  return { orderId, created: !existing };
}

/** Poll the HMIS with the stored cursor; each page and its cursor commit together. */
export async function pullOrders(db: Db, hmis: HmisConnector, maxPages = 20): Promise<{ received: number; created: number }> {
  let received = 0;
  let created = 0;
  for (let page = 0; page < maxPages; page++) {
    const row = await db.hmisCursor.findUnique({ where: { name: 'orders' } });
    const { orders, nextCursor } = await hmis.pullOrders(row?.cursor ?? null);
    if (orders.length === 0) break;
    await db.$transaction(async (tx) => {
      for (const o of orders) {
        const r = await ingestOrder(tx, o);
        received++;
        if (r.created) created++;
      }
      await tx.hmisCursor.upsert({ where: { name: 'orders' }, create: { name: 'orders', cursor: nextCursor }, update: { cursor: nextCursor, updatedAt: new Date() } });
    });
  }
  return { received, created };
}

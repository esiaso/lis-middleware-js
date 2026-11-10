import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createDb, uuidv7, type Db } from '@lis/db';
import { verifyAuditChain } from '@lis/lab';
import { createApp, createUser } from '@lis/web';
import { pino } from 'pino';
import { Browser, PW } from './browser.js';

const url = process.env['TEST_DATABASE_URL'];
const TABLES =
  'user_session, app_user, audit_event, delivery_attempt, outbox_message, result_event, result_version, result, unmatched_result, specimen, ordered_test, lab_order, patient';

describe.skipIf(!url)('orders, collection, labels and specimens over HTTP', () => {
  let db: Db;
  let app: NestExpressApplication;
  let base: string;
  let orderId: string;
  let tests: { tsh: string; ft4: string; glu: string; cancelled: string };
  const as = async (username: string) => {
    const b = new Browser(base);
    expect((await b.signIn(username)).status).toBe(303);
    return b;
  };

  beforeAll(async () => {
    db = createDb(url as string);
    app = await createApp(db, { secureCookies: false, logger: pino({ level: 'silent' }) });
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await app?.close();
    await db?.$disconnect();
  });

  beforeEach(async () => {
    await db.$executeRawUnsafe(`TRUNCATE ${TABLES} CASCADE`);
    for (const [username, roles] of [['phleb', ['operator']], ['tech', ['technologist']], ['aud', ['auditor']]] as const) {
      await createUser(db, { username, displayName: username, password: PW, roles: [...roles] }, 'test');
    }
    const patientId = uuidv7();
    orderId = uuidv7();
    await db.patient.create({ data: { id: patientId, mrn: 'MRN42', familyName: 'Example', givenName: 'Ann', sex: 'F', birthDate: new Date('1980-02-01') } });
    await db.labOrder.create({ data: { id: orderId, hmisOrderId: 'ORD-42', patientId, priority: 'stat', orderedAt: new Date('2026-11-03T08:00:00Z'), status: 'active', sourceJson: {} } });
    const other = uuidv7();
    await db.labOrder.create({ data: { id: other, hmisOrderId: 'ORD-43', patientId, priority: 'routine', orderedAt: new Date('2026-11-03T07:00:00Z'), status: 'active', sourceJson: {} } });
    await db.orderedTest.create({ data: { id: uuidv7(), orderId: other, hmisLineId: '1', hmisTestCode: 'H-CRP', localTestCode: 'CRP', specimenType: 'serum', status: 'active' } });
    tests = { tsh: uuidv7(), ft4: uuidv7(), glu: uuidv7(), cancelled: uuidv7() };
    await db.orderedTest.createMany({
      data: [
        { id: tests.tsh, orderId, hmisLineId: '1', hmisTestCode: 'H-TSH', localTestCode: 'TSH', specimenType: 'serum', status: 'active' },
        { id: tests.ft4, orderId, hmisLineId: '2', hmisTestCode: 'H-FT4', localTestCode: 'FT4', specimenType: 'serum', status: 'active' },
        { id: tests.glu, orderId, hmisLineId: '3', hmisTestCode: 'H-GLU', localTestCode: 'GLU', specimenType: 'fluoride plasma', status: 'active' },
        { id: tests.cancelled, orderId, hmisLineId: '4', hmisTestCode: 'H-X', localTestCode: null, specimenType: 'serum', status: 'cancelled' },
      ],
    });
  });

  async function collect(b: Browser, ids: string[], extra: Record<string, string> = {}) {
    const csrf = await b.csrf(`/orders/${orderId}`);
    return b.post(`/orders/${orderId}/collect`, { _csrf: csrf, testIds: ids, ...extra });
  }

  it('pages through a long order list, keeping the filter', async () => {
    const patient = await db.patient.findFirstOrThrow();
    await db.labOrder.createMany({
      data: Array.from({ length: 60 }, (_, i) => ({ id: uuidv7(), hmisOrderId: `BULK-${String(i).padStart(3, '0')}`, patientId: patient.id, priority: 'routine', orderedAt: new Date(Date.UTC(2026, 10, 4, 0, i)), status: 'active', sourceJson: {} })),
    });
    const b = await as('phleb');
    const first = await b.get('/orders?filter=all');
    expect(first.html).toContain('1–50 of 62');
    expect(first.html.replaceAll('&#x3D;', '=').replaceAll('&amp;', '&')).toContain('href="/orders?filter=all&page=2"');
    const second = await b.get('/orders?filter=all&page=2');
    expect(second.html).toContain('51–62 of 62');
    expect(second.html).toContain('BULK-059');
    expect(second.html).not.toContain('BULK-000');
  });

  it('lists STAT orders first, searches, and sends an exact accession scan to its order', async () => {
    const b = await as('phleb');
    const list = await b.get('/orders');
    expect(list.status).toBe(200);
    expect(list.html.indexOf('ORD-42')).toBeLessThan(list.html.indexOf('ORD-43')); // STAT before an older routine order
    expect(list.html).toContain('STAT');
    const statOnly = await b.get('/orders?stat=1');
    expect(statOnly.html).toContain('ORD-42');
    expect(statOnly.html).not.toContain('ORD-43');
    expect((await b.get('/orders?q=mrn42')).html).toContain('ORD-43');
    expect((await b.get('/orders?q=nobody')).html).toContain('No orders match');

    const r = await collect(b, [tests.tsh]);
    const s = await db.specimen.findFirstOrThrow({ where: { orderId } });
    expect(r.location).toBe(`/specimens/${s.id}/label`);
    const scan = await b.get(`/orders?q=${s.accessionNo.toLowerCase()}`);
    expect(scan.status).toBe(303);
    expect(scan.location).toBe(`/orders/${orderId}`);
  });

  it('groups pending tests by specimen type and collects one container with a barcode label', async () => {
    const b = await as('phleb');
    const order = await b.get(`/orders/${orderId}`);
    expect(order.html).toContain('<strong>serum</strong>');
    expect(order.html).toContain('<strong>fluoride plasma</strong>');
    expect(order.html).toContain('not mapped');
    expect(order.html).toContain(`value="${tests.cancelled}" id="t-${tests.cancelled}" disabled`);

    // Different specimen types cannot share a container.
    expect((await collect(b, [tests.tsh, tests.glu])).status).toBe(409);
    expect((await collect(b, [tests.tsh, tests.cancelled])).status).toBe(409);
    expect((await collect(b, [])).status).toBe(409);
    expect((await collect(b, [tests.tsh], { collectedAt: '2099-01-01T00:00' })).status).toBe(422);

    const r = await collect(b, [tests.tsh, tests.ft4], { collectedAt: '2026-11-03T08:10' });
    expect(r.status).toBe(303);
    const s = await db.specimen.findFirstOrThrow({ where: { orderId }, include: { tests: true } });
    expect(s).toMatchObject({ status: 'collected', labelPrints: 1, createdBy: 'phleb', collectedAt: new Date('2026-11-03T08:10:00Z') });
    expect(s.tests.map((t) => t.localTestCode).sort()).toEqual(['FT4', 'TSH']);

    const label = await b.get(r.location as string);
    expect(label.status).toBe(200);
    expect(label.html).toContain('<svg');
    expect(label.html).toContain(s.accessionNo);
    expect(label.html).toContain('EXAMPLE, Ann');
    expect(label.html).toContain('MRN42');
    expect(label.html).toContain('<strong>STAT</strong>');
    expect(label.html).not.toMatch(/style="/); // CSP: no inline styles from the barcode either

    // Already collected tests cannot be collected again.
    expect((await collect(b, [tests.tsh])).status).toBe(409);
    expect((await b.get(`/orders/${orderId}`)).html).not.toContain(`value="${tests.tsh}"`);
  });

  it('counts reprints, receives, and rejects with recollection', async () => {
    const phleb = await as('phleb');
    await collect(phleb, [tests.tsh, tests.ft4]);
    const s = await db.specimen.findFirstOrThrow({ where: { orderId } });

    const csrf = await phleb.csrf(`/specimens/${s.id}/label`);
    expect((await phleb.post(`/specimens/${s.id}/reprint`, { _csrf: csrf })).location).toBe(`/specimens/${s.id}/label?notice=reprinted`);
    expect((await db.specimen.findUniqueOrThrow({ where: { id: s.id } })).labelPrints).toBe(2);

    // An operator may receive but not reject.
    expect((await phleb.post(`/specimens/${s.id}/reject`, { _csrf: csrf, code: 'haemolysed', text: 'pink serum' })).status).toBe(403);
    expect((await phleb.post(`/specimens/${s.id}/receive`, { _csrf: csrf })).location).toBe(`/orders/${orderId}?notice=received`);
    expect(await db.specimen.findUniqueOrThrow({ where: { id: s.id } })).toMatchObject({ status: 'received', receivedBy: 'phleb' });
    expect((await phleb.post(`/specimens/${s.id}/receive`, { _csrf: csrf })).status).toBe(409);

    const tech = await as('tech');
    const tcsrf = await tech.csrf(`/orders/${orderId}`);
    expect((await tech.post(`/specimens/${s.id}/reject`, { _csrf: tcsrf, code: 'haemolysed', text: '' })).status).toBe(409);
    const rej = await tech.post(`/specimens/${s.id}/reject`, { _csrf: tcsrf, code: 'haemolysed', text: 'grossly pink serum', recollect: 'yes' });
    expect(rej.location).toBe(`/orders/${orderId}?notice=rejected`);
    expect(await db.specimen.findUniqueOrThrow({ where: { id: s.id } })).toMatchObject({ status: 'rejected', rejectionReason: 'haemolysed: grossly pink serum' });
    expect(await db.orderedTest.count({ where: { orderId, specimenId: null, status: 'active' } })).toBe(3); // TSH, FT4 back to collect, plus GLU
    const order = await tech.get(`/orders/${orderId}?notice=rejected`);
    expect(order.html).toContain('Specimen rejected.');
    expect(order.html).toContain('haemolysed: grossly pink serum');

    const timeline = await tech.get(`/specimens/${s.id}`);
    expect(timeline.status).toBe(200);
    for (const t of ['Collected, label printed by phleb', 'Label reprinted by phleb', 'Received in the lab by phleb', 'Rejected by tech']) expect(timeline.html).toContain(t);
    expect((await verifyAuditChain(db)).ok).toBe(true);
  });

  it('lets an auditor look but not collect', async () => {
    const aud = await as('aud');
    const order = await aud.get(`/orders/${orderId}`);
    expect(order.status).toBe(200);
    expect(order.html).not.toContain('Collect and print label');
    const csrf = await aud.csrf(`/orders/${orderId}`);
    expect((await aud.post(`/orders/${orderId}/collect`, { _csrf: csrf, testIds: [tests.tsh] })).status).toBe(403);
    expect((await aud.get(`/orders/${uuidv7()}`)).status).toBe(404);
  });
});

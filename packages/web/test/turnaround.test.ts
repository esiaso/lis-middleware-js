import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createDb, uuidv7, type Db } from '@lis/db';
import { createApp, createUser } from '@lis/web';
import { pino } from 'pino';
import { Browser, PW } from './browser.js';

const url = process.env['TEST_DATABASE_URL'];
const TABLES = 'user_session, app_user, audit_event, result_event, result_version, result, specimen, ordered_test, lab_order, patient';

describe.skipIf(!url)('turnaround report over HTTP', () => {
  let db: Db;
  let app: NestExpressApplication;
  let base: string;
  let patientId: string;
  let n = 0;
  const day = new Date(Date.now() - 86_400_000);
  const at = (min: number) => new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 8, min));

  const as = async (username: string) => {
    const b = new Browser(base);
    expect((await b.signIn(username)).status).toBe(303);
    return b;
  };
  /** A result with given minutes after 08:00 for each step; null leaves the step out. */
  const result = async (test: string, priority: string, m: { collected?: number; received?: number; first?: number; approved?: number; released?: number; accepted?: number }, accession?: string) => {
    n++;
    const orderId = uuidv7();
    const specimenId = uuidv7();
    const testId = uuidv7();
    const resultId = uuidv7();
    const acc = accession ?? `L26110300${String(n).padStart(3, '0')}`;
    await db.labOrder.create({ data: { id: orderId, hmisOrderId: `ORD-${n}`, patientId, priority, orderedAt: at(0), status: 'active', sourceJson: {} } });
    await db.specimen.create({ data: { id: specimenId, orderId, accessionNo: acc, barcode: `B${n}`, status: 'received', collectedAt: m.collected === undefined ? null : at(m.collected), receivedAt: m.received === undefined ? null : at(m.received), createdBy: 'test' } });
    await db.orderedTest.create({ data: { id: testId, orderId, hmisLineId: '1', hmisTestCode: `HMIS-${test}`, localTestCode: test, status: 'collected', specimenId } });
    await db.result.create({ data: { id: resultId, orderedTestId: testId, status: 'sent', selectedVersionNo: 1 } });
    if (m.first !== undefined) await db.resultVersion.create({ data: { id: uuidv7(), resultId, versionNo: 1, kind: 'initial', value: { kind: 'numeric', value: '4.2', scale: 1 }, abnormalFlags: [], createdBy: 'system:x', createdAt: at(m.first) } });
    const ev = (kind: string, min: number | undefined, detail?: object) =>
      min === undefined ? null : db.resultEvent.create({ data: { id: uuidv7(), resultId, kind, versionNo: 1, actor: kind === 'approve' ? 'dr.lab' : 'system:jobs', at: at(min), ...(detail ? { detail } : {}) } });
    await ev('approve', m.approved);
    await ev('release', m.released);
    await ev('delivery', m.accepted, { outcome: 'accepted', status: 'sent' });
  };

  beforeAll(async () => {
    db = createDb(url as string);
    app = await createApp(db, { secureCookies: false, twoPersonRule: true, logger: pino({ level: 'silent' }) });
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await app?.close();
    await db?.$disconnect();
  });
  beforeEach(async () => {
    await db.$executeRawUnsafe(`TRUNCATE ${TABLES} CASCADE`);
    await createUser(db, { username: 'tech', displayName: 'Tech One', password: PW, roles: ['technologist'] }, 'test');
    await createUser(db, { username: 'dr.lab', displayName: 'Dr Lab', password: PW, roles: ['approver'] }, 'test');
    patientId = uuidv7();
    await db.patient.create({ data: { id: patientId, mrn: 'MRN9', familyName: 'Example', givenName: 'Ben' } });
  });

  it('shows medians per step and test, filters by priority, and exports without names', async () => {
    await result('K', 'routine', { collected: 0, received: 30, first: 60, approved: 90, released: 95, accepted: 96 });
    await result('K', 'stat', { collected: 0, received: 10, first: 20, approved: 25, released: 26 });
    await result('NA', 'routine', { collected: 20, received: 10, first: 40 }, '=HYPERLINK("x")');

    const tech = await as('tech');
    const page = await tech.get('/reports/turnaround');
    expect(page.status).toBe(200);
    expect(page.html).toContain('Collected to received in the lab');
    expect(page.html).toContain('1 backwards'); // NA: received before collected
    expect(page.html).toContain('1 h 36 min'); // K routine: collected to accepted
    expect(page.html).not.toContain('Download CSV');
    expect((await tech.get('/reports/turnaround.csv')).status).toBe(403);

    const stat = await tech.get('/reports/turnaround?priority=stat');
    expect(stat.html).toContain('10 min');
    expect(stat.html).not.toContain('1 h 36 min');
    const bad = await tech.get('/reports/turnaround?from=yesterday');
    expect(bad.status).toBe(200);
    expect(bad.html).toContain('is not a date');

    const dr = await as('dr.lab');
    expect((await dr.get('/reports/turnaround')).html).toContain('Download CSV');
    const csv = await dr.get('/reports/turnaround.csv');
    expect(csv.status).toBe(200);
    expect(csv.headers.get('content-type')).toContain('text/csv');
    const lines = csv.html.trim().split('\r\n');
    expect(lines[0]).toBe('accession_no,test,priority,ordered,collected,received,first_value,approved,approved_by,released,accepted_by_hmis');
    expect(lines).toHaveLength(4);
    expect(csv.html).not.toContain('Example');
    expect(csv.html).not.toContain('MRN9');
    expect(csv.html).toContain(`"'=HYPERLINK(""x"")"`);
    expect(await db.auditEvent.count({ where: { action: 'report.turnaround-export' } })).toBe(1);
  });
});

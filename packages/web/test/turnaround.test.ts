import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createDb, uuidv7, type Db } from '@lis/db';
import { createApp, createUser } from '@lis/web';
import { pino } from 'pino';
import { Browser, PW } from './browser.js';

const url = process.env['TEST_DATABASE_URL'];
const TABLES = 'tat_target, user_session, app_user, audit_event, result_event, result_version, result, specimen, ordered_test, lab_order, patient';

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
  const result = async (test: string, priority: string, m: { collected?: number; received?: number; first?: number; approved?: number; released?: number; accepted?: number }, accession?: string, opts: { status?: string; receivedAt?: Date; instrumentId?: string; collector?: string } = {}) => {
    n++;
    const orderId = uuidv7();
    const specimenId = uuidv7();
    const testId = uuidv7();
    const resultId = uuidv7();
    const acc = accession ?? `L26110300${String(n).padStart(3, '0')}`;
    await db.labOrder.create({ data: { id: orderId, hmisOrderId: `ORD-${n}`, patientId, priority, orderedAt: at(0), status: 'active', sourceJson: {} } });
    await db.specimen.create({ data: { id: specimenId, orderId, accessionNo: acc, barcode: `B${n}`, status: 'received', collectedAt: m.collected === undefined ? null : at(m.collected), receivedAt: opts.receivedAt ?? (m.received === undefined ? null : at(m.received)), createdBy: opts.collector ?? 'test' } });
    await db.orderedTest.create({ data: { id: testId, orderId, hmisLineId: '1', hmisTestCode: `HMIS-${test}`, localTestCode: test, status: 'collected', specimenId } });
    await db.result.create({ data: { id: resultId, orderedTestId: testId, status: opts.status ?? 'sent', selectedVersionNo: 1, instrumentId: opts.instrumentId ?? null } });
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
    expect(lines[0]).toBe('accession_no,test,priority,instrument,ordered,collected,collected_by,received,received_by,first_value,entered_by,approved,approved_by,released,released_by,accepted_by_hmis,corrected');
    expect(lines).toHaveLength(4);
    expect(csv.html).not.toContain('Example');
    expect(csv.html).not.toContain('MRN9');
    expect(csv.html).toContain(`"'=HYPERLINK(""x"")"`);
    expect(await db.auditEvent.count({ where: { action: 'report.turnaround-export' } })).toBe(1);
  });

  it('lets the lab set targets, counts late results, and lists unreleased ones past their target', async () => {
    const tech = await as('tech');
    expect((await tech.get('/reports/targets')).html).toContain('No targets.');
    expect((await tech.post('/reports/targets', { _csrf: await tech.csrf('/reports/targets'), localTestCode: '', priority: '', minutes: '60', reference: 'Lab policy TAT-01 v1', password: PW })).status).toBe(403);
    const dr = await as('dr.lab');
    const csrf = await dr.csrf('/reports/targets');
    const form = { _csrf: csrf, localTestCode: '', priority: '', minutes: '120', reference: 'Lab policy TAT-01 v1', password: PW };
    const bad = await dr.post('/reports/targets', { ...form, minutes: '0', password: 'wrong' });
    expect(bad.status).toBe(422);
    expect(bad.html).toContain('1 to 43200 minutes');
    expect((await dr.post('/reports/targets', form)).location).toBe('/reports/targets?notice=target-added');
    expect((await dr.post('/reports/targets', { ...form, priority: 'stat', minutes: '10' })).location).toBe('/reports/targets?notice=target-added');
    expect((await dr.post('/reports/targets', form)).html).toContain('already an active target');

    await result('K', 'routine', { collected: 0, received: 30, first: 60, approved: 90, released: 95 }); // 65 min, target 120: met
    await result('K', 'stat', { collected: 0, received: 10, first: 20, approved: 25, released: 26 }); // 16 min, target 10: late
    await result('NA', 'routine', { first: 0 }, undefined, { status: 'received', receivedAt: new Date(Date.now() - 3 * 3_600_000) }); // pending, 3 h: late
    await result('NA', 'stat', { first: 0 }, undefined, { status: 'reviewed', receivedAt: new Date(Date.now() - 5 * 60_000) }); // pending, 5 min: not yet

    const report = await dr.get('/reports/turnaround');
    expect(report.html).toContain('Received to released, against target');
    expect(report.html).toMatch(/1 met, <span class="text-danger-emphasis">1 late<\/span><br><span class="text-body-secondary">of 2 with a target/);

    const overdue = await dr.get('/reports/overdue');
    expect(overdue.html).toContain('EXAMPLE, Ben (MRN9)');
    expect(overdue.html.match(/<tr><td><a href="\/results\//g)).toHaveLength(1);
    expect((await dr.get('/')).html).toContain('1 result past the turnaround target');

    const any = await db.tatTarget.findFirstOrThrow({ where: { priority: null } });
    expect((await dr.post(`/reports/targets/${any.id}/retire`, { _csrf: csrf, reason: 'policy v2', password: PW })).location).toBe('/reports/targets?notice=target-retired');
    expect((await dr.get('/')).html).not.toContain('past the turnaround target');
    expect((await db.auditEvent.findMany({ where: { entityType: 'tat_target' } })).map((e) => e.action).sort()).toEqual(['tat-target.add', 'tat-target.add', 'tat-target.retire']);
  });

  it('narrows by test, instrument and staff, groups by any of them, and shows the lab indicators', async () => {
    await db.instrument.upsert({ where: { id: 'tat-e411' }, update: {}, create: { id: 'tat-e411', displayName: 'TAT e411', manufacturer: 'Roche', model: 'cobas e 411', discipline: 'immunology', createdBy: 'test' } });
    await result('K', 'routine', { collected: 0, received: 30, first: 60, approved: 90, released: 95 }, undefined, { instrumentId: 'tat-e411', collector: 'tech' });
    await result('K', 'routine', { collected: 10, received: 20, first: 50 }, undefined, { collector: 'nurse.a' });
    await result('NA', 'routine', { collected: 0, received: 40, first: 70, approved: 80, released: 85 }, undefined, { instrumentId: 'tat-e411', collector: 'tech' });

    const dr = await as('dr.lab');
    const all = await dr.get('/reports/turnaround');
    expect(all.html).toContain('Order to report (ordered to released)');
    expect(all.html).toContain('Specimen to report (collected to released)');
    expect(all.html).toContain('2 of 3 results'); // released
    expect(all.html).toContain('<td class="text-nowrap">NA</td>');

    const k = await dr.get('/reports/turnaround?test=K');
    expect(k.html).toContain('1 of 2 results');
    expect(k.html).not.toContain('<td class="text-nowrap">NA</td>');

    const manual = await dr.get('/reports/turnaround?instrument=manual');
    expect(manual.html).toContain('0 of 1 results');
    const e411 = await dr.get('/reports/turnaround?instrument=tat-e411&by=instrument');
    expect(e411.html).toContain('2 of 2 results');
    expect(e411.html).toContain('<td class="text-nowrap">TAT e411</td>');
    expect((await dr.get('/reports/turnaround?by=instrument')).html).toContain('<td class="text-nowrap">Manual entry (no instrument)</td>');

    const tech = await dr.get('/reports/turnaround?staff=tech&role=collectedBy');
    expect(tech.html).toContain('2 of 2 results');
    expect((await dr.get('/reports/turnaround?staff=tech&role=approvedBy')).html).toContain('No results with a specimen collected in this range');
    expect((await dr.get('/reports/turnaround?staff=dr.lab')).html).toContain('2 of 2 results');
    const byCollector = await dr.get('/reports/turnaround?by=collectedBy');
    expect(byCollector.html).toContain('<td class="text-nowrap">Tech One</td>');
    expect(byCollector.html).toContain('<td class="text-nowrap">nurse.a</td>');

    const csv = await dr.get('/reports/turnaround.csv?test=K&instrument=manual');
    const lines = csv.html.trim().split('\r\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain(',nurse.a,');
  });
});

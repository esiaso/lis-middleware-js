import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createDb, uuidv7, type Db } from '@lis/db';
import { createApp, createUser } from '@lis/web';
import { pino } from 'pino';
import { Browser, PW } from './browser.js';

const url = process.env['TEST_DATABASE_URL'];
const TABLES = 'report_settings, user_session, app_user, audit_event, specimen, ordered_test, lab_order, patient';
// A 1x1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

describe.skipIf(!url)('report header settings', () => {
  let db: Db;
  let app: NestExpressApplication;
  let base: string;
  let orderId: string;

  const upload = async (b: Browser, file: Buffer, opts: { csrf?: string; password?: string; type?: string } = {}) => {
    const form = new FormData();
    form.append('_csrf', opts.csrf ?? (await b.csrf('/settings/report')));
    form.append('password', opts.password ?? PW);
    form.append('logo', new Blob([file], { type: opts.type ?? 'image/png' }), 'logo.png');
    const res = await fetch(`${base}/settings/report/logo`, { method: 'POST', redirect: 'manual', body: form, headers: { cookie: [...b.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } });
    return { status: res.status, location: res.headers.get('location'), html: await res.text() };
  };
  const details = { labName: 'County Referral Hospital Laboratory', subtitle: 'Department of Laboratory Medicine', address: 'PO Box 12\n  Kisumu  \n\n', phone: '+254 700 000 000', email: 'lab@example.org', accreditation: 'Demo accreditation wording', reportTitle: 'Laboratory report', footerNote: 'Results relate only to the specimen tested.\nQueries: ext 214.' };

  beforeAll(async () => {
    db = createDb(url as string);
    app = await createApp(db, { secureCookies: false, twoPersonRule: true, logger: pino({ level: 'silent' }), reportHeader: 'Fallback Lab' });
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await app?.close();
    await db?.$disconnect();
  });
  beforeEach(async () => {
    await db.$executeRawUnsafe(`TRUNCATE ${TABLES} CASCADE`);
    await createUser(db, { username: 'admin', displayName: 'Admin One', password: PW, roles: ['admin'] }, 'test');
    await createUser(db, { username: 'tech', displayName: 'Tech One', password: PW, roles: ['technologist'] }, 'test');
    const patientId = uuidv7();
    orderId = uuidv7();
    await db.patient.create({ data: { id: patientId, mrn: 'MRN9', familyName: 'Example', givenName: 'Ben', sex: 'M' } });
    await db.labOrder.create({ data: { id: orderId, hmisOrderId: 'ORD-9', patientId, priority: 'routine', orderedAt: new Date(), status: 'active', sourceJson: {} } });
  });

  it('lets an admin set the letterhead, which every printed report then uses, audited', async () => {
    const tech = new Browser(base);
    await tech.signIn('tech');
    expect((await tech.get('/settings/report')).status).toBe(403);
    expect((await tech.get(`/orders/${orderId}/report`)).html).toContain('Fallback Lab');

    const admin = new Browser(base);
    await admin.signIn('admin');
    const first = await admin.get('/settings/report');
    expect(first.status).toBe(200);
    expect(first.html).toContain('Report header');
    expect(first.html).toContain('Save the lab details first');
    const csrf = await admin.csrf('/settings/report');

    const bad = await admin.post('/settings/report', { _csrf: csrf, ...details, email: 'not an email', labName: '', password: PW });
    expect(bad.status).toBe(422);
    expect(bad.html).toContain('Give the lab name');
    expect(bad.html).toContain('email address does not look right');
    expect(await db.reportSettings.count()).toBe(0);

    expect((await admin.post('/settings/report', { _csrf: csrf, ...details, password: 'wrong password' })).status).toBe(403);
    expect(await db.reportSettings.count()).toBe(0);

    const ok = await admin.post('/settings/report', { _csrf: csrf, ...details, password: PW });
    expect(ok.status).toBe(303);
    expect(ok.location).toBe('/settings/report?notice=report-header-saved');
    const saved = await db.reportSettings.findUniqueOrThrow({ where: { id: 'lab' } });
    expect(saved.address).toBe('PO Box 12\nKisumu');
    expect(saved.updatedBy).toBe('admin');
    const audit = await db.auditEvent.findFirstOrThrow({ where: { action: 'report-header.update' } });
    expect(audit.actor).toBe('admin');
    expect(audit.before).toBeNull();

    const r = (await tech.get(`/orders/${orderId}/report`)).html;
    expect(r).not.toContain('Fallback Lab');
    for (const s of ['County Referral Hospital Laboratory', 'Department of Laboratory Medicine', 'PO Box 12', 'Kisumu', 'Tel +254 700 000 000', 'lab@example.org', 'Demo accreditation wording', 'Results relate only to the specimen tested.']) expect(r).toContain(s);
    expect(r).not.toContain('/settings/report/logo');

    // A second change keeps what it was before in the audit log.
    await admin.post('/settings/report', { _csrf: csrf, ...details, phone: '', password: PW });
    const second = await db.auditEvent.findFirstOrThrow({ where: { action: 'report-header.update' }, orderBy: { seq: 'desc' } });
    expect((second.before as { phone: string }).phone).toBe('+254 700 000 000');
    expect((second.after as { phone: string | null }).phone).toBeNull();
  });

  it('takes a PNG or JPEG logo up to 256 KB, serves it to signed-in users, and can remove it', async () => {
    const admin = new Browser(base);
    await admin.signIn('admin');
    const csrf = await admin.csrf('/settings/report');
    expect((await upload(admin, PNG)).html).toContain('Save the lab details first');
    await admin.post('/settings/report', { _csrf: csrf, ...details, password: PW });

    expect((await upload(admin, PNG, { csrf: 'x'.repeat(64) })).status).toBe(403);
    const svg = await upload(admin, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), { type: 'image/png' });
    expect(svg.status).toBe(422);
    expect(svg.html).toContain('must be a PNG or JPEG');
    const big = await upload(admin, Buffer.concat([PNG, Buffer.alloc(300 * 1024)]));
    expect(big.status).toBe(422);
    expect(big.html).toContain('at most 256 KB');
    expect((await upload(admin, PNG, { password: 'wrong password' })).status).toBe(403);
    expect((await db.reportSettings.findUniqueOrThrow({ where: { id: 'lab' } })).logo).toBeNull();

    const ok = await upload(admin, PNG);
    expect(ok.status).toBe(303);
    expect(ok.location).toBe('/settings/report?notice=report-logo-saved');
    expect(await db.auditEvent.count({ where: { action: 'report-header.logo' } })).toBe(1);

    const tech = new Browser(base);
    await tech.signIn('tech');
    const report = (await tech.get(`/orders/${orderId}/report`)).html;
    const src = /src="(\/settings\/report\/logo\?v=[0-9a-f]{12})"/.exec(report)?.[1];
    expect(src).toBeTruthy();
    const img = await fetch(base + src!, { headers: { cookie: [...tech.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } });
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toContain('image/png');
    expect(Buffer.from(await img.arrayBuffer()).equals(PNG)).toBe(true);
    expect((await fetch(base + src!, { redirect: 'manual' })).status).not.toBe(200); // not without signing in

    const removed = await admin.post('/settings/report/remove-logo', { _csrf: csrf, password: PW });
    expect(removed.status).toBe(303);
    expect((await tech.get('/settings/report/logo')).status).toBe(404);
    expect((await tech.get(`/orders/${orderId}/report`)).html).not.toContain('/settings/report/logo');
  });
});

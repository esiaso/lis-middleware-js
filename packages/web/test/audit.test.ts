import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createDb, type Db } from '@lis/db';
import { appendAudit } from '@lis/lab';
import { createApp, createUser } from '@lis/web';
import { pino } from 'pino';
import { Browser, PW } from './browser.js';

const url = process.env['TEST_DATABASE_URL'];

describe.skipIf(!url)('audit search and export over HTTP', () => {
  let db: Db;
  let app: NestExpressApplication;
  let base: string;
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
    await db.$executeRawUnsafe('TRUNCATE user_session, app_user, audit_event CASCADE');
    await createUser(db, { username: 'aud', displayName: 'Auditor', password: PW, roles: ['auditor'] }, 'test');
    await createUser(db, { username: 'admin', displayName: 'Admin', password: PW, roles: ['admin'] }, 'test');
    await db.$transaction(async (tx) => {
      for (let i = 0; i < 120; i++) {
        await appendAudit(tx, { actor: i % 2 ? 'tech' : 'dr', action: i % 3 ? 'result.review' : 'result.approve', entityType: 'result', entityId: `r-${i}`, reason: `n${i}`, after: { i } });
      }
      await appendAudit(tx, { actor: 'phleb', action: 'specimen.collected', entityType: 'specimen', entityId: 's-1' });
    });
  });

  it('is for auditors only', async () => {
    const admin = await as('admin');
    expect((await admin.get('/audit')).status).toBe(403);
    expect((await admin.get('/audit/export')).status).toBe(403);
    expect((await admin.get('/')).html).not.toContain('href="/audit"');
    const aud = await as('aud');
    expect((await aud.get('/')).html).toContain('href="/audit"');
  });

  it('filters, pages and refuses bad dates', async () => {
    const aud = await as('aud');
    const all = await aud.get('/audit');
    expect(all.status).toBe(200);
    expect(all.html).toContain('specimen.collected');
    expect(all.html).toContain('Older events');

    const spec = await aud.get('/audit?entityType=specimen');
    expect(spec.html).toContain('1 matching events');
    expect(spec.html).toContain('<option value="specimen" selected>');

    const approves = await aud.get('/audit?action=result.approve');
    expect(approves.html).toContain('40 matching events');
    expect((await aud.get('/audit?action=result.')).html).toContain('120 matching events');
    expect((await aud.get('/audit?actor=dr&action=result.approve')).html).toContain('20 matching events');
    expect((await aud.get('/audit?entityId=r-7')).html).toContain('1 matching events');

    const today = new Date().toISOString().slice(0, 10);
    expect((await aud.get(`/audit?from=${today}&to=${today}&entityType=result`)).html).toContain('120 matching events');
    expect((await aud.get('/audit?from=2020-01-01&to=2020-01-02')).html).toContain('No events match');
    const bad = await aud.get('/audit?from=yesterday');
    expect(bad.status).toBe(422);
    expect(bad.html).toContain('From must be a date.');

    // Page two continues where page one stopped, with the filters kept.
    const next = /href="(\/audit\?[^"]*before=\d+)"/.exec(all.html.replaceAll('&amp;', '&').replaceAll('&#x3D;', '='))?.[1];
    expect(next).toBeDefined();
    const older = await aud.get(next!);
    expect(older.html).toContain('result.approve');
    expect(older.html).not.toContain('specimen.collected');
  });

  it('exports JSON lines with a manifest hash, records the export, and keeps the chain checkable', async () => {
    const aud = await as('aud');
    const r = await aud.get('/audit/export?entityType=result');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('application/x-ndjson');
    expect(r.headers.get('content-disposition')).toMatch(/^attachment; filename="audit-\d{8}T\d{6}Z\.jsonl"$/);
    const lines = r.html.trimEnd().split('\n');
    const manifest = JSON.parse(lines.pop()!);
    expect(lines).toHaveLength(120);
    expect(manifest).toMatchObject({ type: 'manifest', format: 'lims-audit-export/1', exportedBy: 'aud', count: 120, signed: false, filters: { entityType: 'result' } });
    expect(manifest.sha256).toBe(createHash('sha256').update(lines.map((l) => `${l}\n`).join('')).digest('hex'));
    const events = lines.map((l) => JSON.parse(l));
    expect(events[0].after).toEqual({ i: 0 });
    // The range is contiguous here, so each event links to the one before it.
    for (let i = 1; i < events.length; i++) expect(events[i].prevHash).toBe(events[i - 1].hash);
    expect(await db.auditEvent.count({ where: { action: 'audit.export', actor: 'aud' } })).toBe(1);
  });

  it('verifies the chain on demand and shows a break plainly', async () => {
    const aud = await as('aud');
    const csrf = await aud.csrf('/audit');
    expect((await aud.post('/audit/verify', { _csrf: csrf })).location).toBe('/audit?notice=chain-ok');
    expect((await aud.get('/audit')).html).toMatch(/Chain last verified .* by aud: 12\d events, all intact/);

    // The append-only trigger stops this even for the owner; simulate a tampered restore by lifting it briefly.
    await db.$executeRawUnsafe('ALTER TABLE audit_event DISABLE TRIGGER audit_event_append_only');
    await db.$executeRawUnsafe(`UPDATE audit_event SET reason = 'edited' WHERE entity_id = 'r-5'`);
    await db.$executeRawUnsafe('ALTER TABLE audit_event ENABLE TRIGGER audit_event_append_only');
    expect((await aud.post('/audit/verify', { _csrf: csrf })).location).toBe('/audit');
    const page = await aud.get('/audit');
    expect(page.html).toContain('Audit chain verification failed');
  });
});

import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createDb, type Db } from '@lis/db';
import { diffMappings } from '@lis/lab';
import { createApp, createUser } from '@lis/web';
import { pino } from 'pino';
import { issueForRows, rowsFromForm, rowsFromMappings } from '../src/mapping-form.js';
import { Browser, PW } from './browser.js';

describe('mapping rows', () => {
  it('reads rows, skips blank and removed ones, and words problems by row', () => {
    const r = rowsFromForm({
      rowCount: '4',
      'r0.local': 'TSH', 'r0.code': '10', 'r0.direction': 'both', 'r0.units': 'uIU/mL', 'r0.decimals': '2', 'r0.reportable': 'yes',
      'r1.local': '', 'r1.code': '',
      'r2.local': 'HIV', 'r2.code': '20', 'r2.direction': 'result', 'r2.qual': '-1=NEG, 1=POS', 'r2.reportable': 'yes', 'r2.ruo': 'yes',
      'r3.local': 'OLD', 'r3.code': '99', 'r3.remove': 'yes',
    });
    expect(r.issues).toEqual([]);
    expect(r.kept).toEqual([0, 2]);
    expect(r.mappings).toEqual([
      { localTestCode: 'TSH', instrumentTestCode: '10', direction: 'both', expectedUnits: 'uIU/mL', decimals: 2, reportable: true, ruo: false },
      { localTestCode: 'HIV', instrumentTestCode: '20', direction: 'result', qualitativeMap: { '-1': 'NEG', '1': 'POS' }, reportable: true, ruo: true },
    ]);
    const bad = rowsFromForm({ rowCount: '2', 'r0.local': 'TSH', 'r0.decimals': '9', 'r1.code': '5', 'r1.local': 'X', 'r1.qual': 'nope' });
    expect(bad.issues).toEqual(['Row 1: instrument code is required', 'Row 1: decimals must be a whole number from 0 to 6', 'Row 2: write qualitative codes as instrument=local, separated by commas (for example -1=NEG, 1=POS)']);
    expect(issueForRows('mappings.1: duplicate result mapping for instrument code 10', [0, 3])).toBe('Row 4: duplicate result mapping for instrument code 10');
    expect(issueForRows('0.expectedUnits: too long', [2])).toBe('Row 3 expectedUnits: too long');
  });

  it('round-trips through the form and lists differences for the approver', () => {
    const list = [{ localTestCode: 'HIV', instrumentTestCode: '20', direction: 'result' as const, qualitativeMap: { '-1': 'NEG' }, reportable: true, ruo: false }];
    const rows = rowsFromMappings(list, 1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ qualitative: '-1=NEG', direction: 'result' });
    const changes = diffMappings(
      [{ localTestCode: 'TSH', instrumentTestCode: '10', direction: 'both', expectedUnits: 'uIU/mL', reportable: true, ruo: false }, { localTestCode: 'OLD', instrumentTestCode: '99', direction: 'both', reportable: true, ruo: false }],
      [{ localTestCode: 'TSH', instrumentTestCode: '10', direction: 'both', expectedUnits: 'mIU/L', reportable: true, ruo: false }, ...list],
    );
    expect(changes).toEqual([
      { kind: 'changed', instrumentTestCode: '10', localTestCode: 'TSH', fields: ['expectedUnits: uIU/mL → mIU/L'] },
      { kind: 'added', instrumentTestCode: '20', localTestCode: 'HIV', fields: [] },
      { kind: 'removed', instrumentTestCode: '99', localTestCode: 'OLD', fields: [] },
    ]);
  });
});

const url = process.env['TEST_DATABASE_URL'];
describe.skipIf(!url)('mapping row editor over HTTP', () => {
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
    await db.$executeRawUnsafe('TRUNCATE user_session, app_user, audit_event, test_mapping_set, instrument_verification_evidence, instrument_connection, instrument CASCADE');
    await createUser(db, { username: 'tech', displayName: 'tech', password: PW, roles: ['technologist'] }, 'test');
    await createUser(db, { username: 'dr', displayName: 'dr', password: PW, roles: ['approver'] }, 'test');
    await db.instrument.create({ data: { id: 'urine-01', displayName: 'Urine', manufacturer: 'Example', model: 'U-100', discipline: 'urinalysis', createdBy: 'test' } });
  });

  const row = (n: number, local: string, code: string, extra: Record<string, string> = {}) => ({ [`r${n}.local`]: local, [`r${n}.code`]: code, [`r${n}.direction`]: 'result', [`r${n}.reportable`]: 'yes', ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [`r${n}.${k}`, v])) });

  it('saves a draft from rows, shows the approver what changed, and starts the next edit from the active set', async () => {
    const tech = await as('tech');
    const empty = await tech.get('/instruments/urine-01/mappings/edit');
    expect(empty.status).toBe(200);
    expect(empty.html).toContain('Started from an empty set');
    expect(empty.html).toContain('name="rowCount" value="5"');
    const csrf = await tech.csrf('/instruments/urine-01/mappings/edit');

    const more = await tech.post('/instruments/urine-01/mappings/rows', { _csrf: csrf, rowCount: '5', ...row(0, 'GLU', '1'), more: 'yes' });
    expect(more.html).toContain('name="rowCount" value="10"');
    expect(more.html).toContain('value="GLU"');
    expect(await db.testMappingSet.count()).toBe(0);

    const bad = await tech.post('/instruments/urine-01/mappings/rows', { _csrf: csrf, rowCount: '3', ...row(0, 'GLU', '1'), ...row(1, 'PRO', '1'), ...row(2, 'KET', '', { decimals: 'x' }) });
    expect(bad.status).toBe(422);
    expect(bad.html).toContain('Row 3: instrument code is required');
    expect(bad.html).toContain('Row 3: decimals must be a whole number from 0 to 6');
    expect(bad.html).toContain('value="PRO"'); // what was typed is kept
    const dup = await tech.post('/instruments/urine-01/mappings/rows', { _csrf: csrf, rowCount: '3', ...row(0, 'GLU', '1'), 'r1.local': '', 'r1.code': '', ...row(2, 'PRO', '1') });
    expect(dup.status).toBe(422);
    expect(dup.html).toContain('Row 3: duplicate result mapping for instrument code 1');
    expect((await tech.post('/instruments/urine-01/mappings/rows', { _csrf: csrf, rowCount: '1', 'r0.local': '', 'r0.code': '' })).html).toContain('Add at least one mapping');

    const ok = await tech.post('/instruments/urine-01/mappings/rows', { _csrf: csrf, rowCount: '3', ...row(0, 'GLU', '1', { units: 'mmol/L', decimals: '1' }), ...row(1, 'PRO', '2', { qual: '0=NEG, 1=TRACE' }) });
    expect(ok.location).toBe('/instruments/urine-01?notice=draft#mappings');
    const draft = await db.testMappingSet.findFirstOrThrow({ where: { status: 'DRAFT' } });
    expect(draft.mappingsJson).toEqual([
      { localTestCode: 'GLU', instrumentTestCode: '1', direction: 'result', expectedUnits: 'mmol/L', decimals: 1, reportable: true, ruo: false },
      { localTestCode: 'PRO', instrumentTestCode: '2', direction: 'result', qualitativeMap: { '0': 'NEG', '1': 'TRACE' }, reportable: true, ruo: false },
    ]);

    const dr = await as('dr');
    expect((await dr.get('/instruments/urine-01/mappings/edit')).status).toBe(403);
    const page = await dr.get('/instruments/urine-01');
    expect(page.html).toMatch(/added<\/span> <span class="font-monospace">1<\/span> &rarr; GLU/);
    const dcsrf = await dr.csrf('/instruments/urine-01');
    expect((await dr.post('/instruments/urine-01/mappings/1/approve', { _csrf: dcsrf, password: PW })).location).toBe('/instruments/urine-01?notice=activated#mappings');

    // Next edit starts from the active set; change units, remove PRO, add BIL.
    const again = await tech.get('/instruments/urine-01/mappings/edit');
    expect(again.html).toContain('Started from the active set, version 1');
    expect(again.html).toContain('value="0&#x3D;NEG, 1&#x3D;TRACE"');
    await tech.post('/instruments/urine-01/mappings/rows', { _csrf: csrf, rowCount: '3', ...row(0, 'GLU', '1', { units: 'mg/dL', decimals: '1' }), ...row(1, 'PRO', '2', { remove: 'yes' }), ...row(2, 'BIL', '3') });
    const review = await dr.get('/instruments/urine-01');
    expect(review.html).toContain('expectedUnits: mmol/L → mg/dL');
    expect(review.html).toMatch(/removed<\/span> <span class="font-monospace">2<\/span> &rarr; PRO/);
    expect(review.html).toMatch(/added<\/span> <span class="font-monospace">3<\/span> &rarr; BIL/);
    expect((await tech.get('/instruments/urine-01/mappings/edit')).html).toContain('Started from the open draft, version 2');
  });
});

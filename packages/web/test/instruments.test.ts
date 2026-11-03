import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createDb, type Db } from '@lis/db';
import { verifyAuditChain } from '@lis/lab';
import { createApp, createUser } from '@lis/web';
import { pino } from 'pino';
import { Browser, PW } from './browser.js';

const url = process.env['TEST_DATABASE_URL'];
const TABLES = 'user_session, app_user, audit_event, instrument_verification_evidence, instrument_connection, test_mapping_set, instrument';

const genericAstm = {
  instrumentId: 'urine-01',
  displayName: 'Urine analyzer',
  manufacturer: 'Example Co',
  model: 'U-100',
  serialNo: 'SN1',
  softwareVersion: '1.0',
  discipline: 'urinalysis',
  location: 'Main lab',
  interfaceManualRef: 'U-100 Host Interface Manual, doc 123, rev B',
  adapter: 'generic-astm',
  adapterOptions: JSON.stringify({ profile: 'generic-astm', sampleId: { record: 'O', field: 3 } }),
  transportType: 'tcp-client',
  host: '10.0.0.20',
  port: '4001',
};

describe.skipIf(!url)('instrument registration, verification and mappings over HTTP', () => {
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
    await db.$executeRawUnsafe(`TRUNCATE ${TABLES} CASCADE`);
    for (const [username, roles] of [['tech', ['technologist']], ['tech2', ['technologist']], ['admin', ['admin']], ['dr', ['approver']], ['dr2', ['approver']]] as const) {
      await createUser(db, { username, displayName: username, password: PW, roles: [...roles] }, 'test');
    }
  });

  async function register(b: Browser, form: Record<string, string> = genericAstm) {
    const csrf = await b.csrf('/instruments/new');
    return b.post('/instruments', { _csrf: csrf, ...form });
  }

  it('registers a generic instrument as unverified and off, and shows why a bad form was refused', async () => {
    const tech = await as('tech');
    const bad = await register(tech, { ...genericAstm, interfaceManualRef: '', adapterOptions: JSON.stringify({ profile: 'generic-astm' }) });
    expect(bad.status).toBe(422);
    expect(bad.html).toContain('interfaceManualRef: required for a generic profile');
    expect(bad.html).toContain('connection.adapterOptions.sampleId');
    expect(bad.html).toContain('value="U-100"'); // what was typed is kept

    const ok = await register(tech);
    expect(ok.location).toBe('/instruments/urine-01?notice=registered');
    const i = await db.instrument.findUniqueOrThrow({ where: { id: 'urine-01' } });
    expect(i).toMatchObject({ verificationStatus: 'UNVERIFIED', enabled: false, createdBy: 'tech' });
    expect(await db.instrumentConnection.count({ where: { instrumentId: 'urine-01', activeTo: null } })).toBe(1);
    const page = await tech.get('/instruments/urine-01');
    expect(page.html).toContain('Not for clinical use');
    expect((await register(tech)).html).toContain('already registered');
  });

  it('asks before saving a generic HL7 profile with no QC rule', async () => {
    const tech = await as('tech');
    const hl7 = { ...genericAstm, instrumentId: 'haem-02', adapter: 'generic-hl7-mllp', adapterOptions: JSON.stringify({ profile: 'generic-hl7-mllp', sampleId: { segment: 'OBR', field: 3 } }) };
    const refused = await register(tech, hl7);
    expect(refused.status).toBe(422);
    expect(refused.html).toContain('no QC rule');
    expect((await register(tech, { ...hl7, noQcConfirmed: 'yes' })).status).toBe(303);
  });

  it('moves through interface test and lab acceptance only with the right evidence and people, then clears for clinical use', async () => {
    await register(await as('tech'));
    const tech = await as('tech');
    let csrf = await tech.csrf('/instruments/urine-01');
    expect((await tech.post('/instruments/urine-01/evidence', { _csrf: csrf, kind: 'suspension', reason: 'technologists cannot do this' })).status).toBe(403);

    const admin = await as('admin');
    csrf = await admin.csrf('/instruments/urine-01');
    const test = { _csrf: csrf, kind: 'interface-test', testedBy: 'Field Engineer', organisation: 'Example Co', testedAt: '2026-11-02', recordRef: 'IVR-2026-07' };
    const mismatch = await admin.post('/instruments/urine-01/evidence', { ...test, softwareVersion: '0.9' });
    expect(mismatch.status).toBe(409);
    expect(mismatch.html).toContain('does not match registered');
    // Lab acceptance cannot skip the interface test, and an administrator cannot sign it.
    expect((await admin.post('/instruments/urine-01/evidence', { _csrf: csrf, kind: 'lab-acceptance', acceptanceRef: 'PR-1', password: PW })).status).toBe(403);
    expect((await admin.post('/instruments/urine-01/evidence', { ...test, softwareVersion: '1.0' })).status).toBe(303);

    const dr = await as('dr');
    csrf = await dr.csrf('/instruments/urine-01');
    expect((await dr.post('/instruments/urine-01/evidence', { _csrf: csrf, kind: 'lab-acceptance', acceptanceRef: 'PR-1', password: 'wrong' })).status).toBe(403);
    expect((await dr.post('/instruments/urine-01/evidence', { _csrf: csrf, kind: 'lab-acceptance', acceptanceRef: 'PR-1', password: PW })).status).toBe(303);
    expect((await admin.post('/instruments/urine-01/enabled', { _csrf: await admin.csrf('/instruments/urine-01'), enabled: 'true', reason: 'go live' })).status).toBe(403);
    expect((await dr.post('/instruments/urine-01/enabled', { _csrf: csrf, enabled: 'true', reason: 'go live after acceptance' })).status).toBe(303);

    expect(await db.instrument.findUniqueOrThrow({ where: { id: 'urine-01' } })).toMatchObject({ verificationStatus: 'LAB_ACCEPTED', enabled: true, verifiedSoftwareVersion: '1.0' });
    expect((await dr.get('/instruments/urine-01')).html).toContain('Cleared for clinical use');
    const evidence = await db.instrumentVerificationEvidence.findMany({ orderBy: { recordedAt: 'asc' } });
    expect(evidence.map((e) => [e.kind, e.toStatus, e.recordedBy])).toEqual([['interface-test', 'VENDOR_TESTED', 'admin'], ['lab-acceptance', 'LAB_ACCEPTED', 'dr']]);
    expect(await verifyAuditChain(db)).toMatchObject({ ok: true });
  });

  it('resets to unverified when the software changes, and keeps old connection settings when only the link changes', async () => {
    await register(await as('tech'));
    await db.instrument.update({ where: { id: 'urine-01' }, data: { verificationStatus: 'LAB_ACCEPTED', verifiedSoftwareVersion: '1.0', enabled: true } });
    const tech = await as('tech');
    let edit = await tech.get('/instruments/urine-01/edit');
    let csrf = /name="_csrf" value="([0-9a-f]{64})"/.exec(edit.html)![1]!;
    let rowVersion = /name="rowVersion" value="(\d+)"/.exec(edit.html)![1]!;
    expect(edit.html).toContain('value="10.0.0.20"');

    const moved = await tech.post('/instruments/urine-01/edit', { _csrf: csrf, rowVersion, ...genericAstm, port: '4002' });
    expect(moved.location).toBe('/instruments/urine-01?notice=retest');
    expect(await db.instrument.findUniqueOrThrow({ where: { id: 'urine-01' } })).toMatchObject({ verificationStatus: 'LAB_ACCEPTED', enabled: true });
    const conns = await db.instrumentConnection.findMany({ where: { instrumentId: 'urine-01' }, orderBy: { activeFrom: 'asc' } });
    expect(conns).toHaveLength(2);
    expect(conns[0]!.activeTo).not.toBeNull();
    expect((conns[1]!.configJson as { transport: { port: number } }).transport.port).toBe(4002);

    // A stale form (old row version) is refused rather than overwriting someone else's change.
    expect((await tech.post('/instruments/urine-01/edit', { _csrf: csrf, rowVersion, ...genericAstm, softwareVersion: '1.1' })).status).toBe(409);

    edit = await tech.get('/instruments/urine-01/edit');
    csrf = /name="_csrf" value="([0-9a-f]{64})"/.exec(edit.html)![1]!;
    rowVersion = /name="rowVersion" value="(\d+)"/.exec(edit.html)![1]!;
    const upgraded = await tech.post('/instruments/urine-01/edit', { _csrf: csrf, rowVersion, ...genericAstm, port: '4002', softwareVersion: '1.1' });
    expect(upgraded.location).toBe('/instruments/urine-01?notice=reset');
    expect(await db.instrument.findUniqueOrThrow({ where: { id: 'urine-01' } })).toMatchObject({ verificationStatus: 'UNVERIFIED', enabled: false, verifiedSoftwareVersion: null, softwareVersion: '1.1' });
  });

  it('activates a mapping draft only after a different approver approves it, retiring the previous set', async () => {
    await register(await as('tech'));
    const mappings = (code: string) => JSON.stringify([{ localTestCode: 'UPROT', instrumentTestCode: code, direction: 'result' }, { localTestCode: 'RUO-X', instrumentTestCode: '99', direction: 'result', ruo: true }]);

    const tech = await as('tech');
    let csrf = await tech.csrf('/instruments/urine-01');
    const bad = await tech.post('/instruments/urine-01/mappings', { _csrf: csrf, mappings: JSON.stringify([{ localTestCode: 'X', instrumentTestCode: '1', direction: 'sideways' }]) });
    expect(bad.status).toBe(422);
    expect((await tech.post('/instruments/urine-01/mappings', { _csrf: csrf, mappings: 'not json' })).status).toBe(422);
    expect((await tech.post('/instruments/urine-01/mappings', { _csrf: csrf, mappings: mappings('PRO') })).location).toBe('/instruments/urine-01?notice=draft#mappings');
    expect((await tech.post('/instruments/urine-01/mappings/1/approve', { _csrf: csrf, password: PW })).status).toBe(403); // not an approver

    const dr = await as('dr');
    csrf = await dr.csrf('/instruments/urine-01');
    expect((await dr.get('/instruments/urine-01')).html).toContain('Approve and make active');
    expect((await dr.post('/instruments/urine-01/mappings/1/approve', { _csrf: csrf, password: PW })).status).toBe(303);
    expect(await db.testMappingSet.findFirstOrThrow({ where: { versionNo: 1 } })).toMatchObject({ status: 'ACTIVE', createdBy: 'tech', approvedBy: 'dr' });

    // Someone with both roles who saves a draft is its author and cannot approve it.
    await db.appUser.update({ where: { username: 'dr' }, data: { roles: ['technologist', 'approver'] } });
    expect((await dr.post('/instruments/urine-01/mappings', { _csrf: csrf, mappings: mappings('PRO2') })).status).toBe(303);
    const own = await dr.post('/instruments/urine-01/mappings/2/approve', { _csrf: csrf, password: PW });
    expect(own.status).toBe(409);
    expect(own.html).toContain('cannot approve their own');

    const dr2 = await as('dr2');
    expect((await dr2.post('/instruments/urine-01/mappings/2/approve', { _csrf: await dr2.csrf('/instruments/urine-01'), password: PW })).status).toBe(303);
    const sets = await db.testMappingSet.findMany({ orderBy: { versionNo: 'asc' } });
    expect(sets.map((s) => [s.versionNo, s.status])).toEqual([[1, 'RETIRED'], [2, 'ACTIVE']]);
    expect((await dr2.get('/instruments/urine-01')).html).toContain('no (research use only)');
  });
});

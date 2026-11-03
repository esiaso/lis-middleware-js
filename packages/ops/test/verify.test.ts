import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@lis/db';
import { checkDatabase, checkRuntime, checkSecrets, checkSums, findBundleRoot, runVerify, tcpProbe, type BundleManifest } from '@lis/ops';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

describe('bundle checks', () => {
  let root: string;
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function bundle(files: Record<string, string>, sums = files): string {
    root = mkdtempSync(join(tmpdir(), 'lims-bundle-'));
    for (const [f, body] of Object.entries(files)) {
      mkdirSync(join(root, f, '..'), { recursive: true });
      writeFileSync(join(root, f), body);
    }
    writeFileSync(join(root, 'SHA256SUMS'), Object.entries(sums).map(([f, b]) => `${sha(b)}  ${f}`).join('\n') + '\n');
    writeFileSync(join(root, 'manifest.json'), '{}');
    return root;
  }

  it('passes when every listed file matches', async () => {
    const r = await checkSums(bundle({ 'app/a.js': 'a', 'bin/lims': 'b' }));
    expect(r).toMatchObject({ status: 'pass', detail: '2 files match SHA256SUMS' });
  });

  it('names changed and missing files', async () => {
    root = bundle({ 'app/a.js': 'tampered' }, { 'app/a.js': 'a', 'app/gone.js': 'x' });
    const r = await checkSums(root);
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('app/a.js: changed');
    expect(r.detail).toContain('app/gone.js: missing');
  });

  it('refuses paths that leave the bundle', async () => {
    root = bundle({});
    writeFileSync(join(root, 'SHA256SUMS'), `${sha('x')}  ../../etc/passwd\n`);
    expect((await checkSums(root)).detail).toContain('outside the bundle');
  });

  it('finds the bundle root from LIMS_HOME or by walking up', () => {
    root = bundle({ 'app/node_modules/@lis/ops/dist/main.js': '' });
    expect(findBundleRoot({ LIMS_HOME: root })).toBe(root);
    expect(findBundleRoot({}, join(root, 'app', 'node_modules', '@lis', 'ops', 'dist'))).toBe(root);
    expect(findBundleRoot({}, tmpdir())).toBeUndefined();
  });
});

describe('runtime and credential checks', () => {
  const manifest = (over: Partial<BundleManifest>): BundleManifest => ({ name: 'lims-middleware', version: '1.0.0', commit: 'abc', platform: process.platform, arch: process.arch, node: process.version, migrations: [], builtAt: '', ...over });

  it('fails when the bundle was built for another Node or platform', () => {
    expect(checkRuntime(manifest({})).status).toBe('pass');
    expect(checkRuntime(manifest({ node: 'v20.0.0' })).detail).toContain('built for Node v20.0.0');
    expect(checkRuntime(manifest({ platform: 'aix' })).status).toBe('fail'); // a platform no CI runner has
    expect(checkRuntime(undefined).status).toBe('skip');
  });

  it('says where the credential comes from, never what it is', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lims-cred-'));
    writeFileSync(join(dir, 'database_url'), 'postgresql://u:secret@h/db\n');
    try {
      const fromFile = checkSecrets({ DATABASE_URL_FILE: join(dir, 'database_url') });
      expect(fromFile.status).toBe('pass');
      expect(fromFile.detail).not.toContain('secret');
      expect(checkSecrets({ CREDENTIALS_DIRECTORY: dir }).detail).toContain('systemd credential');
      expect(checkSecrets({ DATABASE_URL: 'postgresql://u:secret@h/db' })).toMatchObject({ status: 'warn' });
      expect(checkSecrets({}).status).toBe('fail');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('diag tcp', () => {
  it('reports a connection without sending anything, and a refusal', async () => {
    let received = 0;
    const server = createServer((s) => s.on('data', (d) => (received += d.length)));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    expect(await tcpProbe('127.0.0.1', port)).toMatchObject({ ok: true });
    await new Promise<void>((r) => server.close(() => r()));
    expect(received).toBe(0);
    expect((await tcpProbe('127.0.0.1', port)).detail).toContain('ECONNREFUSED');
  });
});

const url = process.env['TEST_DATABASE_URL'];
describe.skipIf(!url)('database checks', () => {
  let db: Db;
  beforeAll(() => {
    db = createDb(url as string);
  });
  afterAll(async () => {
    await db?.$disconnect();
  });

  it('passes on a migrated database and reports missing migrations', async () => {
    await db.$executeRawUnsafe('TRUNCATE user_session, app_user, audit_event, instrument CASCADE');
    const ok = await checkDatabase(db);
    expect(Object.fromEntries(ok.map((c) => [c.name, c.status]))).toEqual({ database: 'pass', migrations: 'pass', 'audit chain': 'pass', instruments: 'pass', accounts: 'warn' });
    const missing = await checkDatabase(db, ['20990101000000_future']);
    expect(missing.find((c) => c.name === 'migrations')).toMatchObject({ status: 'fail' });
    expect(missing.find((c) => c.name === 'migrations')!.detail).toContain('20990101000000_future');
  });

  it('flags an instrument whose stored connection config no longer validates', async () => {
    await db.$executeRawUnsafe('TRUNCATE instrument CASCADE');
    await db.instrument.create({ data: { id: 'bad-01', displayName: 'x', manufacturer: 'x', model: 'x', discipline: 'other', createdBy: 't' } });
    await db.instrumentConnection.create({ data: { id: '0190f6a2-7c1e-7d8a-9b3c-123456789abc', instrumentId: 'bad-01', configJson: { adapter: 'nope' }, activeFrom: new Date(), createdBy: 't' } });
    const r = await checkDatabase(db);
    expect(r.find((c) => c.name === 'instruments')).toMatchObject({ status: 'fail', detail: 'bad-01: connection config invalid' });
  });

  it('writes a report whose result follows the checks', async () => {
    await db.$executeRawUnsafe('TRUNCATE instrument CASCADE');
    const r = await runVerify({ db, env: { DATABASE_URL_FILE: '/nonexistent' } });
    expect(r.text).toContain('FAIL  database credential');
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/RESULT: FAIL\n$/);
  });
});

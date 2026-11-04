import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@lis/db';
import { appendAudit } from '@lis/lab';
import { createBackup, libpqEnv, readBackup, verifyBackup } from '@lis/ops';

describe('backup connection settings', () => {
  it('passes the address to the PostgreSQL tools in the environment, decoded', () => {
    expect(libpqEnv('postgresql://lims_app:p%40ss%2Fw@db.local:5433/lims?sslmode=verify-full&schema=public')).toEqual({ PGHOST: 'db.local', PGPORT: '5433', PGDATABASE: 'lims', PGUSER: 'lims_app', PGPASSWORD: 'p@ss/w', PGSSLMODE: 'verify-full' });
    expect(libpqEnv('postgres://u@localhost/x')).toEqual({ PGHOST: 'localhost', PGPORT: '5432', PGDATABASE: 'x', PGUSER: 'u' });
    expect(() => libpqEnv('mysql://u@h/x')).toThrow(/postgresql/);
    expect(() => libpqEnv('postgresql://u@h/')).toThrow(/no database/);
  });
});

const url = process.env['TEST_DATABASE_URL'];
describe.skipIf(!url)('lims backup create and verify against PostgreSQL', () => {
  let db: Db;
  let dir: string;
  let scratchUrl: string;
  // Worked out only when the suite runs: without a database it is skipped, and its body must not throw.
  let scratchName = '';

  beforeAll(async () => {
    scratchName = `${new URL(url as string).pathname.slice(1)}_restore`;
    db = createDb(url as string);
    dir = mkdtempSync(join(tmpdir(), 'lims-backup-'));
    await db.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratchName}"`);
    await db.$executeRawUnsafe(`CREATE DATABASE "${scratchName}"`);
    const u = new URL(url as string);
    u.pathname = `/${scratchName}`;
    scratchUrl = u.href;
    await db.$transaction((tx) => appendAudit(tx, { actor: 'test', action: 'test.before-backup', entityType: 'test', entityId: 'b-1' }));
  });
  afterAll(async () => {
    await db?.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratchName}"`);
    await db?.$disconnect();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('dumps from one snapshot, restores into an empty scratch database, checks the chain there, and empties it again', async () => {
    const r = await createBackup(db, url as string, { outDir: dir, version: '0.1.0', actor: 'admin' });
    expect(r.m).toMatchObject({ format: 'lims-backup/1', version: '0.1.0', file: r.dump.split(/[\\/]/).pop() });
    // The backup holds the record of its own making, and nothing written after its snapshot.
    const last = await db.auditEvent.findFirstOrThrow({ where: { action: 'backup.create' }, orderBy: { seq: 'desc' } });
    expect(r.m.auditHead).toEqual({ seq: String(last.seq), hash: last.hash });
    expect(r.m.counts['audit_event']).toBe(await db.auditEvent.count());
    expect(readBackup(r.dump).m.sha256).toBe(r.m.sha256);

    const quick = await verifyBackup(r.dump);
    expect(quick.ok).toBe(true);
    expect(quick.checks.map((c) => `${c.name}:${c.status}`)).toEqual(['manifest:pass', 'file:pass', 'readable:pass', 'restore:warn']);

    // A live database is never written to: anything with tables is refused.
    const refused = await verifyBackup(r.dump, { restoreTo: url as string });
    expect(refused.ok).toBe(false);
    expect(refused.checks.at(-1)!.detail).toMatch(/already has \d+ table\(s\); use an empty one. Nothing was written./);

    const full = await verifyBackup(r.dump, { restoreTo: scratchUrl });
    expect(full.checks.map((c) => `${c.name}:${c.status}`)).toEqual(['manifest:pass', 'file:pass', 'readable:pass', 'restore:pass', 'migrations:pass', 'audit chain:pass', 'row counts:pass', 'cleanup:pass']);
    expect(full.ok).toBe(true);
    const scratch = createDb(scratchUrl);
    try {
      const [left] = await scratch.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema')`;
      expect(Number(left!.n)).toBe(0);
    } finally {
      await scratch.$disconnect();
    }

    // A manifest that does not describe the dump is caught after the restore.
    const manifestPath = r.dump.replace(/\.dump$/, '.json');
    const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
    writeFileSync(manifestPath, JSON.stringify({ ...m, counts: { ...m.counts, result: m.counts.result + 1 }, auditHead: { ...m.auditHead, hash: '0'.repeat(64) } }));
    const wrong = await verifyBackup(r.dump, { restoreTo: scratchUrl });
    expect(wrong.ok).toBe(false);
    expect(wrong.checks.find((c) => c.name === 'audit chain')).toMatchObject({ status: 'fail', detail: 'intact, but its head is not the one recorded in the manifest' });
    expect(wrong.checks.find((c) => c.name === 'row counts')?.detail).toMatch(/^result \d+ not \d+$/);

    // A damaged file is caught before anything is restored.
    writeFileSync(manifestPath, JSON.stringify(m));
    const bytes = readFileSync(r.dump);
    bytes[bytes.length - 10] = (bytes[bytes.length - 10] ?? 0) ^ 0xff;
    writeFileSync(r.dump, bytes);
    const damaged = await verifyBackup(r.dump, { restoreTo: scratchUrl });
    expect(damaged.checks.map((c) => `${c.name}:${c.status}`)).toEqual(['manifest:pass', 'file:fail']);
    expect((await verifyBackup(join(dir, 'nothing.dump'))).checks[0]).toMatchObject({ name: 'manifest', status: 'fail' });
  });
});

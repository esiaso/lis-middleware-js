import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { Prisma as PrismaTypes } from '@prisma/client';
import { createDb, migrationStatus, Prisma, type Db } from '@lis/db';
import { appendAudit, verifyAuditChain } from '@lis/lab';
import type { Check } from './verify.js';

/**
 * `lims backup create` and `lims backup verify` (11 §8, §9 step 2).
 *
 * This is the middleware's own logical backup, for an upgrade or a hand-off;
 * it does not replace the hospital's nightly backup and WAL archiving
 * (D-21). The dump and the manifest's counts come from one database
 * snapshot, so they agree even while the services run. Verifying means
 * restoring: a backup is only known good once it has been loaded into an
 * empty scratch database and its audit chain checked there.
 */

export const BACKUP_FORMAT = 'lims-backup/1';
/** Tables whose row counts are compared after a restore. */
export const COUNTED = ['audit_event', 'patient', 'lab_order', 'specimen', 'result', 'result_version', 'instrument', 'test_mapping_set', 'app_user', 'outbox_message', 'inbox_message'] as const;

export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  createdAt: string;
  host: string;
  version: string | undefined;
  database: string;
  serverVersion: string;
  pgDumpVersion: string;
  migrations: string[];
  counts: Record<string, number>;
  auditHead: { seq: string; hash: string } | null;
  file: string;
  bytes: number;
  sha256: string;
}

/** Connection settings for libpq tools, passed in the environment so the password is never on a command line. */
export function libpqEnv(url: string): Record<string, string> {
  const u = new URL(url);
  if (!/^postgres(ql)?:$/.test(u.protocol)) throw new Error('not a postgresql:// address');
  const env: Record<string, string> = {
    PGHOST: decodeURIComponent(u.hostname.replace(/^\[|\]$/g, '')) || 'localhost',
    PGPORT: u.port || '5432',
    PGDATABASE: decodeURIComponent(u.pathname.slice(1)),
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
  };
  const host = u.searchParams.get('host');
  if (host) env['PGHOST'] = host; // unix socket directory
  const ssl = u.searchParams.get('sslmode');
  if (ssl) env['PGSSLMODE'] = ssl;
  for (const [k, v] of Object.entries(env)) if (!v) delete env[k];
  if (!env['PGDATABASE']) throw new Error('the database address names no database');
  return env;
}

/** "pg_dump (PostgreSQL) 16.15 (Ubuntu ...)" → 16 */
export function toolMajor(versionText: string): number | undefined {
  const m = /\(PostgreSQL\)\s+(\d+)/.exec(versionText);
  return m ? Number(m[1]) : undefined;
}

/**
 * pg_dump / pg_restore of the server's major version: a newer pg_restore
 * writes settings an older server rejects, and an older one cannot read a
 * newer archive. Looked for in --pg-bin, then the usual install folders for
 * that version, then PATH.
 */
export function findPgTool(name: 'pg_dump' | 'pg_restore', o: { pgBin?: string | undefined; major?: number | undefined; platform?: NodeJS.Platform } = {}): string {
  const platform = o.platform ?? process.platform;
  const exe = platform === 'win32' ? `${name}.exe` : name;
  const candidates: string[] = [];
  if (o.pgBin) candidates.push(join(o.pgBin, exe));
  else {
    const winRoot = join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'PostgreSQL');
    const dirs = platform === 'win32' ? (existsSync(winRoot) ? readdirSync(winRoot) : []) : existsSync('/usr/lib/postgresql') ? readdirSync('/usr/lib/postgresql') : [];
    const ordered = [...dirs].sort((a, b) => (Number(a) === o.major ? -1 : Number(b) === o.major ? 1 : Number(b) - Number(a)));
    for (const v of ordered) candidates.push(platform === 'win32' ? join(winRoot, v, 'bin', exe) : `/usr/lib/postgresql/${v}/bin/${name}`);
    candidates.push(exe);
  }
  const found: string[] = [];
  for (const c of candidates) {
    const r = spawnSync(c, ['--version'], { encoding: 'utf8' });
    if (r.status !== 0) continue;
    const major = toolMajor(r.stdout ?? '');
    if (o.major === undefined || major === o.major) return c;
    found.push(`${c} is version ${major ?? '?'}`);
  }
  const want = o.major ? ` version ${o.major} (the server's major version)` : '';
  throw new Error(`${name}${want} not found${o.pgBin ? ` in ${o.pgBin}` : ''}${found.length ? ` (${found.join('; ')})` : ''}; install the PostgreSQL client tools${want}, or pass --pg-bin`);
}

async function serverMajor(db: Db): Promise<number> {
  const [r] = await db.$queryRaw<{ v: string }[]>`SELECT current_setting('server_version_num') AS v`;
  return Math.floor(Number(r!.v) / 10000);
}

function run(cmd: string, args: string[], env: Record<string, string>): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', (c: Buffer) => (stderr = (stderr + c.toString()).slice(-8000)));
    p.on('error', reject);
    p.on('close', (code) => resolve({ code: code ?? 1, stderr }));
  });
}

async function sha256(file: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
  return h.digest('hex');
}

type Tx = PrismaTypes.TransactionClient;

async function snapshotFacts(tx: Tx | Db): Promise<{ counts: Record<string, number>; auditHead: BackupManifest['auditHead']; migrations: string[]; serverVersion: string; database: string }> {
  const counts: Record<string, number> = {};
  for (const t of COUNTED) {
    const [row] = await tx.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*)::bigint AS n FROM "${t}"`);
    counts[t] = Number(row!.n);
  }
  const [head] = await tx.$queryRaw<{ seq: bigint; hash: string }[]>`SELECT seq, hash FROM audit_event ORDER BY seq DESC LIMIT 1`;
  const migrations = (await tx.$queryRaw<{ migration_name: string }[]>`SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`).map((m) => m.migration_name);
  const [v] = await tx.$queryRaw<{ v: string; d: string }[]>`SELECT current_setting('server_version') AS v, current_database() AS d`;
  return { counts, auditHead: head ? { seq: String(head.seq), hash: head.hash } : null, migrations, serverVersion: v!.v, database: v!.d };
}

/**
 * Dump the database from one snapshot: a repeatable-read transaction exports
 * its snapshot, pg_dump reads exactly that, and the manifest's counts and
 * audit head are read inside the same transaction.
 */
export async function createBackup(db: Db, url: string, o: { outDir: string; pgBin?: string; version?: string; now?: Date; actor?: string }): Promise<{ dump: string; manifest: string; m: BackupManifest }> {
  const pgDump = findPgTool('pg_dump', { pgBin: o.pgBin, major: await serverMajor(db) });
  const pgDumpVersion = (spawnSync(pgDump, ['--version'], { encoding: 'utf8' }).stdout ?? '').trim();
  if (!existsSync(o.outDir) || !statSync(o.outDir).isDirectory()) throw new Error(`${o.outDir} does not exist`);
  const now = o.now ?? new Date();
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const name = `lims-backup-${stamp}`;
  const dump = join(o.outDir, `${name}.dump`);
  const partial = `${dump}.partial`;
  const env = libpqEnv(url);
  // Recorded first, so the backup carries the record of its own making.
  await db.$transaction((tx) => appendAudit(tx, { actor: o.actor ?? 'system:cli', action: 'backup.create', entityType: 'backup', entityId: name, after: { file: basename(dump) } }));
  let facts: Awaited<ReturnType<typeof snapshotFacts>>;
  try {
    facts = await db.$transaction(
      async (tx) => {
        const [snap] = await tx.$queryRaw<{ id: string }[]>`SELECT pg_export_snapshot() AS id`;
        const f = await snapshotFacts(tx);
        const r = await run(pgDump, ['--format=custom', '--no-owner', '--no-acl', `--snapshot=${snap!.id}`, `--file=${partial}`], env);
        if (r.code !== 0) throw new Error(`pg_dump failed: ${r.stderr.trim().split('\n').pop() ?? `exit ${r.code}`}`);
        return f;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 6 * 3600_000, maxWait: 30_000 },
    );
  } catch (e) {
    rmSync(partial, { force: true });
    throw e;
  }
  renameSync(partial, dump);
  const m: BackupManifest = {
    format: BACKUP_FORMAT,
    createdAt: now.toISOString(),
    host: hostname(),
    version: o.version,
    database: facts.database,
    serverVersion: facts.serverVersion,
    pgDumpVersion,
    migrations: facts.migrations,
    counts: facts.counts,
    auditHead: facts.auditHead,
    file: basename(dump),
    bytes: statSync(dump).size,
    sha256: await sha256(dump),
  };
  const manifest = join(o.outDir, `${name}.json`);
  writeFileSync(manifest, `${JSON.stringify(m, null, 2)}\n`);
  return { dump, manifest, m };
}

/** The manifest beside a dump, or the dump beside a manifest. */
export function readBackup(path: string): { dump: string; m: BackupManifest } {
  const manifestPath = path.endsWith('.json') ? path : path.replace(/\.dump$/, '.json');
  if (!existsSync(manifestPath)) throw new Error(`no manifest ${manifestPath} beside the backup`);
  const m = JSON.parse(readFileSync(manifestPath, 'utf8')) as BackupManifest;
  if (m.format !== BACKUP_FORMAT) throw new Error(`${manifestPath} is not a ${BACKUP_FORMAT} manifest`);
  return { dump: join(dirname(manifestPath), m.file), m };
}

/** Remove what the restore created: every table, view, sequence, function and type outside the system schemas. */
const CLEAR_SCRATCH = `DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT format('DROP TABLE IF EXISTS %I.%I CASCADE', schemaname, tablename) AS q FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema') LOOP EXECUTE r.q; END LOOP;
  FOR r IN SELECT format('DROP VIEW IF EXISTS %I.%I CASCADE', schemaname, viewname) AS q FROM pg_views WHERE schemaname NOT IN ('pg_catalog', 'information_schema') LOOP EXECUTE r.q; END LOOP;
  FOR r IN SELECT format('DROP SEQUENCE IF EXISTS %I.%I CASCADE', schemaname, sequencename) AS q FROM pg_sequences WHERE schemaname NOT IN ('pg_catalog', 'information_schema') LOOP EXECUTE r.q; END LOOP;
  FOR r IN SELECT format('DROP FUNCTION IF EXISTS %s CASCADE', p.oid::regprocedure) AS q FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%' LOOP EXECUTE r.q; END LOOP;
  FOR r IN SELECT format('DROP TYPE IF EXISTS %I.%I CASCADE', n.nspname, t.typname) AS q FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND t.typtype IN ('e', 'd', 'c') AND (t.typtype <> 'c' OR NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = t.typrelid AND c.relkind <> 'c')) LOOP EXECUTE r.q; END LOOP;
END $$`;

const lastLine = (s: string) => s.trim().split('\n').filter(Boolean).pop() ?? '';

/**
 * Check a backup. Without a scratch database: the file is whole and
 * pg_restore can read its table of contents. With one (`restoreTo`): load
 * it there and check migrations, the audit chain, the head hash and the
 * row counts against the manifest. The scratch database must be empty, so
 * a live database can never be written to by mistake.
 */
export async function verifyBackup(path: string, o: { restoreTo?: string; pgBin?: string; keep?: boolean } = {}): Promise<{ checks: Check[]; ok: boolean }> {
  const checks: Check[] = [];
  const done = () => ({ checks, ok: checks.every((c) => c.status !== 'fail') });
  let dump: string;
  let m: BackupManifest;
  try {
    ({ dump, m } = readBackup(path));
  } catch (e) {
    checks.push({ name: 'manifest', status: 'fail', detail: (e as Error).message });
    return done();
  }
  checks.push({ name: 'manifest', status: 'pass', detail: `made ${m.createdAt} on ${m.host}${m.version ? `, version ${m.version}` : ''}; ${m.counts['audit_event'] ?? 0} audit events, ${m.counts['result'] ?? 0} results` });
  if (!existsSync(dump)) {
    checks.push({ name: 'file', status: 'fail', detail: `${dump} is missing` });
    return done();
  }
  const sum = await sha256(dump);
  if (sum !== m.sha256) {
    checks.push({ name: 'file', status: 'fail', detail: `checksum differs from the manifest: the file is damaged or was changed` });
    return done();
  }
  checks.push({ name: 'file', status: 'pass', detail: `${statSync(dump).size} bytes, SHA-256 matches` });

  let pgRestore: string;
  try {
    // Reading the archive works with any version at least as new; restoring needs the scratch server's version (below).
    pgRestore = findPgTool('pg_restore', { pgBin: o.pgBin });
  } catch (e) {
    checks.push({ name: 'readable', status: 'fail', detail: (e as Error).message });
    return done();
  }
  const list = spawnSync(pgRestore, ['--list', dump], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (list.status !== 0) {
    checks.push({ name: 'readable', status: 'fail', detail: `pg_restore cannot read it: ${lastLine(list.stderr)}` });
    return done();
  }
  const entries = list.stdout.split('\n').filter((l) => l && !l.startsWith(';')).length;
  checks.push({ name: 'readable', status: 'pass', detail: `${entries} entries` });

  if (!o.restoreTo) {
    checks.push({ name: 'restore', status: 'warn', detail: 'not restored; pass --scratch-url-file with the address of an empty scratch database to prove it loads' });
    return done();
  }
  const scratch = createDb(o.restoreTo);
  try {
    try {
      const [row] = await scratch.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema')`;
      if (Number(row!.n) > 0) {
        checks.push({ name: 'restore', status: 'fail', detail: `the scratch database already has ${row!.n} table(s); use an empty one. Nothing was written.` });
        return done();
      }
    } catch (e) {
      checks.push({ name: 'restore', status: 'fail', detail: `cannot connect to the scratch database: ${lastLine((e as Error).message)}` });
      return done();
    }
    try {
      pgRestore = findPgTool('pg_restore', { pgBin: o.pgBin, major: await serverMajor(scratch) });
    } catch (e) {
      checks.push({ name: 'restore', status: 'fail', detail: (e as Error).message });
      return done();
    }
    const r = await run(pgRestore, ['--no-owner', '--no-acl', '--exit-on-error', '--single-transaction', '--dbname', libpqEnv(o.restoreTo)['PGDATABASE']!, dump], libpqEnv(o.restoreTo));
    if (r.code !== 0) {
      checks.push({ name: 'restore', status: 'fail', detail: `pg_restore failed: ${lastLine(r.stderr)}` });
      return done();
    }
    checks.push({ name: 'restore', status: 'pass', detail: 'loaded into the scratch database' });
    const mig = await migrationStatus(scratch, m.migrations);
    checks.push(mig.ok ? { name: 'migrations', status: 'pass', detail: `${mig.applied.length} applied, as in the manifest` } : { name: 'migrations', status: 'fail', detail: `differ from the manifest: missing ${mig.missing.join(', ') || 'none'}, failed ${mig.failed.join(', ') || 'none'}` });
    const chain = await verifyAuditChain(scratch);
    if (!chain.ok) checks.push({ name: 'audit chain', status: 'fail', detail: `broken at event ${chain.brokenAtSeq}` });
    else if ((m.auditHead?.hash ?? null) !== (chain.count ? chain.head : null)) checks.push({ name: 'audit chain', status: 'fail', detail: `intact, but its head is not the one recorded in the manifest` });
    else checks.push({ name: 'audit chain', status: 'pass', detail: `${chain.count} events intact, head matches the manifest (${(m.auditHead?.hash ?? '').slice(0, 16)}…)` });
    const facts = await snapshotFacts(scratch);
    const differ = COUNTED.filter((t) => facts.counts[t] !== m.counts[t]).map((t) => `${t} ${facts.counts[t]} not ${m.counts[t]}`);
    checks.push(differ.length ? { name: 'row counts', status: 'fail', detail: differ.join('; ') } : { name: 'row counts', status: 'pass', detail: `${COUNTED.length} tables match the manifest` });
    if (!o.keep) {
      // It was empty before, so everything in it is what the restore made. It holds patient data: clear it.
      // Not DROP OWNED: when the role also owns system objects (a bootstrap superuser) that is refused.
      await scratch.$executeRawUnsafe(CLEAR_SCRATCH);
      const [left] = await scratch.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema')`;
      checks.push(Number(left!.n) === 0 ? { name: 'cleanup', status: 'pass', detail: 'scratch database emptied again (it held patient data); --keep leaves it' } : { name: 'cleanup', status: 'warn', detail: `${left!.n} table(s) could not be removed from the scratch database; drop it by hand (it holds patient data)` });
    } else checks.push({ name: 'cleanup', status: 'warn', detail: 'scratch database kept with the restored data, which includes patient data; drop it when done' });
    return done();
  } finally {
    await scratch.$disconnect();
  }
}

import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { arch, hostname, platform } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InstrumentConnectionConfig } from '@lis/contracts';
import { databaseUrlFromEnv, migrationStatus, type Db } from '@lis/db';
import { verifyAuditChain } from '@lis/lab';

/**
 * `lims verify` (11 §4.1): checks run on the target server itself, saved as
 * evidence for the installation qualification. Every check reports names
 * and counts only, never secret values.
 */

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip';
export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface BundleManifest {
  name: string;
  version: string;
  commit: string;
  platform: string;
  arch: string;
  node: string;
  migrations: string[];
  builtAt: string;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The release bundle root holds manifest.json. Found from LIMS_HOME, or by walking up from this file. */
export function findBundleRoot(env: NodeJS.ProcessEnv = process.env, start = dirname(fileURLToPath(import.meta.url))): string | undefined {
  if (env['LIMS_HOME'] && existsSync(join(env['LIMS_HOME'], 'manifest.json'))) return resolve(env['LIMS_HOME']);
  let dir = start;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'manifest.json')) && existsSync(join(dir, 'SHA256SUMS'))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return undefined;
}

export function readManifest(root: string): BundleManifest {
  return JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')) as BundleManifest;
}

export function checkRuntime(manifest: BundleManifest | undefined): Check {
  const here = `Node ${process.version} ${platform()}-${arch()}`;
  if (!manifest) return { name: 'runtime', status: 'skip', detail: `${here}; not running from a release bundle` };
  const problems: string[] = [];
  if (manifest.node !== process.version) problems.push(`bundle was built for Node ${manifest.node}`);
  if (manifest.platform !== platform() || manifest.arch !== arch()) problems.push(`bundle is for ${manifest.platform}-${manifest.arch}`);
  return problems.length ? { name: 'runtime', status: 'fail', detail: `${here}: ${problems.join('; ')}` } : { name: 'runtime', status: 'pass', detail: `${here}, bundle ${manifest.version} (${manifest.commit.slice(0, 12)})` };
}

async function sha256(file: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
  return h.digest('hex');
}

/** Every file listed in SHA256SUMS is present and unchanged. */
export async function checkSums(root: string | undefined): Promise<Check> {
  if (!root) return { name: 'bundle checksums', status: 'skip', detail: 'not running from a release bundle' };
  const lines = readFileSync(join(root, 'SHA256SUMS'), 'utf8').split('\n').filter(Boolean);
  const bad: string[] = [];
  for (const line of lines) {
    const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
    if (!m) {
      bad.push(`unreadable line: ${line.slice(0, 40)}`);
      continue;
    }
    const rel = m[2] as string;
    const file = resolve(root, rel);
    if (!file.startsWith(root + sep)) {
      bad.push(`${rel}: outside the bundle`);
      continue;
    }
    if (!existsSync(file)) bad.push(`${rel}: missing`);
    else if ((await sha256(file)) !== m[1]) bad.push(`${rel}: changed`);
  }
  return bad.length
    ? { name: 'bundle checksums', status: 'fail', detail: `${bad.length} of ${lines.length} files: ${bad.slice(0, 5).join('; ')}${bad.length > 5 ? '; …' : ''}` }
    : { name: 'bundle checksums', status: 'pass', detail: `${lines.length} files match SHA256SUMS` };
}

/** The native serial module loads on this server and can list ports (11 §4.1). */
export async function checkSerial(): Promise<Check> {
  try {
    const { autoDetect } = await import('@serialport/bindings-cpp');
    const ports = await autoDetect().list();
    return { name: 'serial module', status: 'pass', detail: ports.length ? `loaded; ports: ${ports.map((p) => p.path).join(', ')}` : 'loaded; no serial ports on this server' };
  } catch (e) {
    return { name: 'serial module', status: 'fail', detail: `could not load or list ports: ${errText(e)}` };
  }
}

export function checkSecrets(env: NodeJS.ProcessEnv = process.env): Check {
  try {
    const { source } = databaseUrlFromEnv(env);
    const warn = source.startsWith('DATABASE_URL environment');
    return { name: 'database credential', status: warn ? 'warn' : 'pass', detail: warn ? `${source}: use a credential file on a server` : `from ${source}` };
  } catch (e) {
    return { name: 'database credential', status: 'fail', detail: errText(e) };
  }
}

export async function checkDatabase(db: Db, expected?: string[]): Promise<Check[]> {
  try {
    await db.$queryRaw`SELECT 1`;
  } catch (e) {
    return [{ name: 'database', status: 'fail', detail: `cannot connect: ${errText(e).split('\n').filter(Boolean).pop() ?? ''}` }];
  }
  const out: Check[] = [{ name: 'database', status: 'pass', detail: 'connected' }];
  try {
    const m = await migrationStatus(db, expected);
    if (m.failed.length) out.push({ name: 'migrations', status: 'fail', detail: `failed or unfinished: ${m.failed.join(', ')}` });
    else if (m.missing.length) out.push({ name: 'migrations', status: 'fail', detail: `not applied: ${m.missing.join(', ')} (run "lims db migrate")` });
    else out.push({ name: 'migrations', status: 'pass', detail: `${m.applied.length} applied${m.unknown.length ? `; newer than this build: ${m.unknown.join(', ')}` : ''}` });
  } catch (e) {
    out.push({ name: 'migrations', status: 'fail', detail: `no migration history: ${errText(e).split('\n').filter(Boolean).pop() ?? ''} (run "lims db migrate")` });
    return out;
  }
  try {
    const a = await verifyAuditChain(db);
    out.push(a.ok ? { name: 'audit chain', status: 'pass', detail: `${a.count} events, head ${a.head.slice(0, 16)}…` } : { name: 'audit chain', status: 'fail', detail: `broken at event ${a.brokenAtSeq}` });
  } catch (e) {
    out.push({ name: 'audit chain', status: 'fail', detail: errText(e) });
  }
  const instruments = await db.instrument.findMany({ orderBy: { id: 'asc' } });
  const configProblems: string[] = [];
  for (const i of instruments) {
    const conn = await db.instrumentConnection.findFirst({ where: { instrumentId: i.id, activeTo: null }, orderBy: { activeFrom: 'desc' } });
    if (!conn) configProblems.push(`${i.id}: no active connection`);
    else if (!InstrumentConnectionConfig.safeParse(conn.configJson).success) configProblems.push(`${i.id}: connection config invalid`);
  }
  const cleared = instruments.filter((i) => i.enabled && i.verificationStatus === 'LAB_ACCEPTED' && i.verifiedSoftwareVersion === i.softwareVersion).length;
  out.push(
    configProblems.length
      ? { name: 'instruments', status: 'fail', detail: configProblems.join('; ') }
      : { name: 'instruments', status: 'pass', detail: `${instruments.length} registered, ${cleared} cleared for clinical use` },
  );
  const admins = await db.appUser.count({ where: { active: true, roles: { has: 'admin' } } });
  out.push(admins ? { name: 'accounts', status: 'pass', detail: `${admins} active administrator account(s)` } : { name: 'accounts', status: 'warn', detail: 'no administrator yet: run "lims-web create-user"' });
  return out;
}

export interface VerifyReport {
  checks: Check[];
  ok: boolean;
  text: string;
}

export async function runVerify(o: { db: Db | undefined; env?: NodeJS.ProcessEnv; bundleRoot?: string | undefined; now?: Date }): Promise<VerifyReport> {
  const env = o.env ?? process.env;
  const manifest = o.bundleRoot ? readManifest(o.bundleRoot) : undefined;
  const checks: Check[] = [checkRuntime(manifest), await checkSums(o.bundleRoot), await checkSerial(), checkSecrets(env)];
  if (o.db) checks.push(...(await checkDatabase(o.db, manifest?.migrations)));
  else checks.push({ name: 'database', status: 'fail', detail: 'no database credential, so the database was not checked' });
  const ok = checks.every((c) => c.status !== 'fail');
  const width = Math.max(...checks.map((c) => c.name.length));
  const text = [
    `lims verify on ${hostname()} at ${(o.now ?? new Date()).toISOString()}`,
    manifest ? `bundle ${manifest.name} ${manifest.version} ${manifest.platform}-${manifest.arch}` : 'not a release bundle',
    '',
    ...checks.map((c) => `${c.status.toUpperCase().padEnd(4)}  ${c.name.padEnd(width)}  ${c.detail}`),
    '',
    ok ? 'RESULT: PASS' : 'RESULT: FAIL',
    '',
  ].join('\n');
  return { checks, ok, text };
}

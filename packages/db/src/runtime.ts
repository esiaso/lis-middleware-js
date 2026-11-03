import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './client.js';

/**
 * Where the database URL comes from, in order (11 §3, §4):
 * 1. systemd `LoadCredential=database_url:` ($CREDENTIALS_DIRECTORY/database_url);
 * 2. `DATABASE_URL_FILE`, a file readable only by the service account (Windows);
 * 3. `DATABASE_URL` (development and tests).
 * The value itself is never logged; `source` names where it came from.
 */
export function databaseUrlFromEnv(env: NodeJS.ProcessEnv = process.env): { url: string; source: string } {
  const dir = env['CREDENTIALS_DIRECTORY'];
  if (dir) return { url: readFileSync(join(dir, 'database_url'), 'utf8').trim(), source: 'systemd credential database_url' };
  const file = env['DATABASE_URL_FILE'];
  if (file) return { url: readFileSync(file, 'utf8').trim(), source: `file ${file}` };
  const url = env['DATABASE_URL'];
  if (url) return { url, source: 'DATABASE_URL environment variable' };
  throw new Error('no database URL: set DATABASE_URL_FILE (Windows), LoadCredential=database_url (Linux), or DATABASE_URL');
}

/** `prisma/` ships next to `dist/` in this package. */
export const PRISMA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'prisma');
export const SCHEMA_PATH = join(PRISMA_DIR, 'schema.prisma');

/** Migrations this build expects, in order. */
export function bundledMigrations(dir = join(PRISMA_DIR, 'migrations')): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

export interface MigrationStatus {
  ok: boolean;
  expected: string[];
  applied: string[];
  missing: string[];
  /** Started but never finished, or rolled back: needs a person before anything starts. */
  failed: string[];
  /** Applied to the database but unknown to this build (a newer version ran here). */
  unknown: string[];
}

export async function migrationStatus(db: Db, expected = bundledMigrations()): Promise<MigrationStatus> {
  const rows = await db.$queryRaw<{ migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }[]>`
    SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY migration_name`;
  const applied = rows.filter((r) => r.finished_at && !r.rolled_back_at).map((r) => r.migration_name);
  const failed = rows.filter((r) => !r.finished_at && !r.rolled_back_at).map((r) => r.migration_name);
  const missing = expected.filter((m) => !applied.includes(m));
  const unknown = applied.filter((m) => !expected.includes(m));
  // Expand-only migrations (06 §3.3): a newer schema is fine for an older build, so `unknown` is not a failure.
  return { ok: missing.length === 0 && failed.length === 0, expected, applied, missing, failed, unknown };
}

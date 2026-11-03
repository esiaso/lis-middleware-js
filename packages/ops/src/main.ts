#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { createDb, databaseUrlFromEnv, SCHEMA_PATH, type Db } from '@lis/db';
import { statusReport, tcpProbe } from './status.js';
import { findBundleRoot, runVerify } from './verify.js';

const USAGE = `usage:
  lims verify [--out <dir>]     check this server (11 §4.1); writes verify-<timestamp>.txt to --out
  lims status                   instrument links, leases and queue depths
  lims db migrate               apply the database migrations shipped with this version
  lims diag tcp <host> <port>   test a TCP connection to a device server (sends nothing)
  lims version                  show the bundle version`;

function openDb(): Db | undefined {
  try {
    return createDb(databaseUrlFromEnv().url);
  } catch {
    return undefined;
  }
}

async function main(argv: string[]): Promise<number> {
  const [cmd, sub, ...rest] = argv;
  switch (cmd) {
    case 'verify': {
      const db = openDb();
      const outIdx = argv.indexOf('--out');
      try {
        const report = await runVerify({ db, bundleRoot: findBundleRoot() });
        process.stdout.write(report.text);
        if (outIdx >= 0 && argv[outIdx + 1]) {
          const dir = argv[outIdx + 1] as string;
          mkdirSync(dir, { recursive: true });
          const file = join(dir, `verify-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`);
          writeFileSync(file, report.text);
          process.stdout.write(`saved ${file}\n`);
        }
        return report.ok ? 0 : 1;
      } finally {
        await db?.$disconnect();
      }
    }
    case 'status': {
      const db = createDb(databaseUrlFromEnv().url);
      try {
        process.stdout.write(await statusReport(db));
        return 0;
      } finally {
        await db.$disconnect();
      }
    }
    case 'db': {
      if (sub !== 'migrate') break;
      // Prisma applies only migrations that are not yet recorded, each in its own transaction.
      const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');
      const r = spawnSync(process.execPath, [prismaCli, 'migrate', 'deploy', '--schema', SCHEMA_PATH], {
        stdio: 'inherit',
        env: { ...process.env, DATABASE_URL: databaseUrlFromEnv().url, PRISMA_HIDE_UPDATE_MESSAGE: '1', CHECKPOINT_DISABLE: '1' },
      });
      return r.status ?? 1;
    }
    case 'diag': {
      const [host, port] = rest;
      if (sub !== 'tcp' || !host || !port || !/^\d+$/.test(port)) break;
      const r = await tcpProbe(host, Number(port));
      process.stdout.write(`${r.ok ? 'OK' : 'FAILED'}: ${r.detail}\n`);
      return r.ok ? 0 : 1;
    }
    case 'version': {
      const root = findBundleRoot();
      process.stdout.write(root ? `${(await import('./verify.js')).readManifest(root).version}\n` : 'not a release bundle\n');
      return 0;
    }
  }
  process.stderr.write(`${USAGE}\n`);
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    process.stderr.write(`lims: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  },
);

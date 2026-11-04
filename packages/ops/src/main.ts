#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { basename, join } from 'node:path';
import { createDb, databaseUrlFromEnv, SCHEMA_PATH, type Db } from '@lis/db';
import { defaultSources, formatChecks, parseEnvFile, parseServiceXml, summariseConfig, validateConfig, type ConfigSource } from './config.js';
import { buildDiagBundle, collectLogs } from './diag.js';
import { readSecretInput, SECRETS, setSecret } from './secrets.js';
import { statusReport, tcpProbe } from './status.js';
import { findBundleRoot, runVerify } from './verify.js';

const USAGE = `usage:
  lims verify [--out <dir>]     check this server (11 §4.1); writes verify-<timestamp>.txt to --out
  lims status                   instrument links, leases and queue depths
  lims db migrate               apply the database migrations shipped with this version
  lims config validate [--env-file <file> | --service-dir <dir>]
                                check every service's settings before starting them
  lims secrets set <name>       store a secret (value on standard input or typed unseen); names: ${Object.keys(SECRETS).join(', ')}
  lims diag tcp <host> <port>   test a TCP connection to a device server (sends nothing)
  lims diag bundle [--out <dir>] [--log-dir <dir>]
                                one .tar.gz for support: reports, settings and recent logs, secrets removed
  lims version                  show the bundle version`;

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** --env-file or --service-dir if given, else this server's usual place. */
function settingsSources(argv: string[]): ConfigSource[] | string {
  const file = flag(argv, '--env-file');
  if (file) {
    try {
      const text = readFileSync(file, 'utf8');
      return [{ label: file.endsWith('.xml') ? basename(file, '.xml') : basename(file), path: file, web: !file.endsWith('.xml') || basename(file) === 'lims-web.xml', values: file.endsWith('.xml') ? parseServiceXml(text) : parseEnvFile(text) }];
    } catch (e) {
      return `cannot read ${file}: ${(e as Error).message}`;
    }
  }
  const root = findBundleRoot();
  return defaultSources({ serviceDir: flag(argv, '--service-dir') ?? (root ? join(root, 'service') : undefined) });
}

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
        const report = await runVerify({ db, bundleRoot: findBundleRoot(), settings: summariseConfig(validateConfig(settingsSources(argv))) });
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
    case 'config': {
      if (sub !== 'validate') break;
      const r = validateConfig(settingsSources(argv));
      process.stdout.write(formatChecks('lims config validate', r.checks, r.ok));
      return r.ok ? 0 : 1;
    }
    case 'secrets': {
      const [name] = rest;
      if (sub !== 'set' || !name) break;
      if (!SECRETS[name]) {
        process.stderr.write(`unknown secret "${name}"; known: ${Object.keys(SECRETS).join(', ')}\n`);
        return 2;
      }
      try {
        const r = setSecret(name, await readSecretInput());
        process.stdout.write(`${r.replaced ? 'replaced' : 'stored'} ${name} in ${r.path} (read by ${SECRETS[name]!.readers}). Restart those services to use it.\n${r.note ? `${r.note}\n` : ''}`);
        return 0;
      } catch (e) {
        process.stderr.write(`${(e as Error).message}\n`);
        return 1;
      }
    }
    case 'diag': {
      if (sub === 'bundle') {
        const db = openDb();
        try {
          const settings = settingsSources(argv);
          const root = findBundleRoot();
          const verify = await runVerify({ db, bundleRoot: root, settings: summariseConfig(validateConfig(settings)) });
          let status: string | undefined;
          try {
            status = db ? await statusReport(db) : undefined;
          } catch {
            status = undefined;
          }
          const logDir = flag(argv, '--log-dir');
          const out = flag(argv, '--out') ?? (process.platform === 'win32' ? join(process.env['ProgramData'] ?? 'C:\\ProgramData', 'LIMS Middleware', 'logs') : tmpdir());
          const b = buildDiagBundle({ verify: verify.text, status, settings, logs: collectLogs(logDir ? { logDir } : {}), version: root ? (await import('./verify.js')).readManifest(root).version : undefined });
          mkdirSync(out, { recursive: true });
          const file = join(out, b.file);
          writeFileSync(file, b.data, { mode: 0o600 });
          process.stdout.write(`saved ${file} (${b.data.length} bytes)${b.missing.length ? `\nnot collected:\n  ${b.missing.join('\n  ')}` : ''}\n`);
          return 0;
        } finally {
          await db?.$disconnect();
        }
      }
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

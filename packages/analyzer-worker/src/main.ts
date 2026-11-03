#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
import { createDb } from '@lis/db';
import { runWorker, type WorkerExit } from './worker.js';

/** Exit codes the service manager and runbooks rely on (11 §11). */
const EXIT_CODES: Record<WorkerExit['reason'], number> = {
  stopped: 0,
  'not-configured': 2,
  'lease-held': 3,
  'lease-lost': 4,
  disabled: 5,
};

function databaseUrl(): string {
  // systemd LoadCredential= puts secrets in $CREDENTIALS_DIRECTORY (11 §4); env is the fallback for Windows/WinSW.
  const dir = process.env['CREDENTIALS_DIRECTORY'];
  if (dir) return readFileSync(join(dir, 'database_url'), 'utf8').trim();
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL is not set and no credentials directory is available');
  return url;
}

async function main(): Promise<number> {
  const i = process.argv.indexOf('--instrument');
  const instrumentId = i >= 0 ? process.argv[i + 1] : undefined;
  const logger = pino({ base: { svc: 'analyzer-worker', instrumentId }, redact: ['*.password', '*.secret', '*.url'] });
  if (!instrumentId) {
    logger.error({}, 'usage: lims-analyzer-worker --instrument <id>');
    return 2;
  }
  const db = createDb(databaseUrl());
  const ac = new AbortController();
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => ac.abort());
  try {
    const exit = await runWorker({ db, instrumentId, owner: `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`, logger, signal: ac.signal });
    if (exit.reason !== 'stopped') logger.error(exit, 'worker exited');
    return EXIT_CODES[exit.reason];
  } finally {
    await db.$disconnect();
  }
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(e);
    process.exit(1);
  },
);

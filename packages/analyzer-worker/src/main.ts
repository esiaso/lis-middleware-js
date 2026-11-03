#!/usr/bin/env node
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
import { createDb, databaseUrlFromEnv } from '@lis/db';
import { runWorker, type WorkerExit } from './worker.js';

/** Exit codes the service manager and runbooks rely on (11 §11). */
const EXIT_CODES: Record<WorkerExit['reason'], number> = {
  stopped: 0,
  'not-configured': 2,
  'lease-held': 3,
  'lease-lost': 4,
  disabled: 5,
};

async function main(): Promise<number> {
  const i = process.argv.indexOf('--instrument');
  const instrumentId = i >= 0 ? process.argv[i + 1] : undefined;
  const logger = pino({ base: { svc: 'analyzer-worker', instrumentId }, redact: ['*.password', '*.secret', '*.url'] });
  if (!instrumentId) {
    logger.error({}, 'usage: lims-analyzer-worker --instrument <id>');
    return 2;
  }
  const db = createDb(databaseUrlFromEnv().url);
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

#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import { createDb } from '@lis/db';
import { runIntakeLoop } from './loop.js';

function databaseUrl(): string {
  const dir = process.env['CREDENTIALS_DIRECTORY'];
  if (dir) return readFileSync(join(dir, 'database_url'), 'utf8').trim();
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL is not set and no credentials directory is available');
  return url;
}

const logger = pino({ base: { svc: 'jobs' }, redact: ['*.password', '*.secret', '*.url'] });
const db = createDb(databaseUrl());
const ac = new AbortController();
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => ac.abort());

runIntakeLoop({
  db,
  worker: `${hostname()}:${process.pid}`,
  signal: ac.signal,
  onOutcome: (o) => (o.status === 'done' ? logger.info(o, 'inbox processed') : logger.warn(o, 'inbox not processed')),
  onError: (e) => logger.error({ err: e.message }, 'intake loop error'),
})
  .then(() => db.$disconnect())
  .then(
    () => process.exit(0),
    (e: unknown) => {
      logger.error({ err: (e as Error).message }, 'jobs worker crashed');
      process.exit(1);
    },
  );

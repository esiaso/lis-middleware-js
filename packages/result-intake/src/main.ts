#!/usr/bin/env node
import { hostname } from 'node:os';
import { pino } from 'pino';
import { createDb, databaseUrlFromEnv } from '@lis/db';
import { runIntakeLoop } from './loop.js';

const logger = pino({ base: { svc: 'jobs' }, redact: ['*.password', '*.secret', '*.url'] });
const db = createDb(databaseUrlFromEnv().url);
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

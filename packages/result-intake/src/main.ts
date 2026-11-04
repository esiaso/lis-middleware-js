#!/usr/bin/env node
import { hostname } from 'node:os';
import { pino } from 'pino';
import { createDb, databaseUrlFromEnv } from '@lis/db';
import { FhirR4Hmis, fhirHmisSettingsFromEnv } from '@lis/hmis';
import { pollEveryMsFromEnv, runHmisLoop } from './hmis-loop.js';
import { runIntakeLoop } from './loop.js';

const logger = pino({ base: { svc: 'jobs' }, redact: ['*.password', '*.secret', '*.url'] });
const db = createDb(databaseUrlFromEnv().url);
const ac = new AbortController();
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => ac.abort());

const worker = `${hostname()}:${process.pid}`;
// The HMIS link runs only when it is configured (LIMS_HMIS_PROFILE); a half-done setup stops the worker with the reason.
const hmisSettings = fhirHmisSettingsFromEnv();
if (!hmisSettings) logger.warn('no HMIS is configured (LIMS_HMIS_PROFILE): orders are not pulled and released results wait in the outbox');

Promise.all([
  runIntakeLoop({
    db,
    worker,
    signal: ac.signal,
    onOutcome: (o) => (o.status === 'done' ? logger.info(o, 'inbox processed') : logger.warn(o, 'inbox not processed')),
    onError: (e) => logger.error({ err: e.message }, 'intake loop error'),
  }),
  hmisSettings
    ? runHmisLoop({
        db,
        hmis: new FhirR4Hmis(hmisSettings),
        worker,
        signal: ac.signal,
        pollEveryMs: pollEveryMsFromEnv(),
        onPull: (r) => logger.info(r, 'HMIS orders received'),
        onDelivery: (r) => (r.outcome === 'accepted' || r.outcome === 'confirmed' ? logger.info(r, 'result sent to the HMIS') : logger.warn(r, 'result not yet delivered')),
        onError: (what, e) => logger.error({ err: e.message }, what === 'orders' ? 'HMIS order poll failed' : 'HMIS result delivery failed'),
      })
    : Promise.resolve(),
])
  .then(() => db.$disconnect())
  .then(
    () => process.exit(0),
    (e: unknown) => {
      logger.error({ err: (e as Error).message }, 'jobs worker crashed');
      process.exit(1);
    },
  );

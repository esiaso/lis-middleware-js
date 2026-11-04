#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { pino } from 'pino';
import { createDb, databaseUrlFromEnv } from '@lis/db';
import { createApp } from './app.js';
import { createUser, ROLES, type Role } from './auth.js';
import { oidcSettingsFromEnv } from './oidc.js';

async function readPassword(): Promise<string> {
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    rl.close();
    return line;
  }
  throw new Error('no password on standard input');
}

const logger = pino({ base: { svc: 'web' }, redact: ['*.password', '*.secret', '*.url'] });
const db = createDb(databaseUrlFromEnv().url);

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'create-user') {
    // lims-web create-user <username> "<display name>" <role,role>  (password on stdin)
    const [username, displayName, roles] = args;
    if (!username || !displayName || !roles) throw new Error('usage: lims-web create-user <username> "<display name>" <roles, comma separated> < password-file');
    const list = roles.split(',').map((r) => r.trim()) as Role[];
    if (list.some((r) => !ROLES.includes(r))) throw new Error(`roles must be among: ${ROLES.join(', ')}`);
    await createUser(db, { username, displayName, roles: list, password: await readPassword() }, 'system:cli');
    logger.info({ username, roles: list }, 'user created');
    return;
  }
  const oidc = oidcSettingsFromEnv();
  if (oidc) logger.info({ issuer: oidc.issuer.href, clientId: oidc.clientId, groups: [...oidc.roleMap.keys()] }, 'hospital sign-in configured');
  const app = await createApp(db, {
    logger,
    ...(oidc ? { oidc } : {}),
    twoPersonRule: process.env['LIMS_TWO_PERSON_RULE'] !== 'false',
    ...(process.env['LIMS_TIME_ZONE']?.trim() ? { timeZone: process.env['LIMS_TIME_ZONE'].trim() } : {}),
    ...(process.env['LIMS_REPORT_HEADER']?.trim() ? { reportHeader: process.env['LIMS_REPORT_HEADER'].trim().slice(0, 120) } : {}),
    // TLS terminates at the reverse proxy (11 §4); only a loopback-only test setup turns this off.
    secureCookies: process.env['LIMS_INSECURE_COOKIES'] !== 'true',
  });
  const port = Number(process.env['PORT'] ?? 3000);
  const host = process.env['BIND_HOST'] ?? '127.0.0.1';
  await app.listen(port, host);
  logger.info({ host, port }, 'web listening');
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => void app.close().then(() => db.$disconnect()));
}

main().catch(async (e: unknown) => {
  logger.error({ err: (e as Error).message }, 'web failed');
  await db.$disconnect();
  process.exit(1);
});

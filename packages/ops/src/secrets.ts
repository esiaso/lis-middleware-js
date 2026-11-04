import { randomBytes } from 'node:crypto';
import { existsSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodeSecret, type DpapiRunner } from '@lis/db';

/**
 * `lims secrets set <name>` (11 §3 step 4, §4): store a credential in the
 * file the services read, so it never sits in the settings, on a command
 * line, or in shell history. The value comes from standard input.
 */
export const SECRETS: Record<string, { readers: string; check: (v: string) => string | undefined; after?: (platform: NodeJS.Platform) => string | undefined }> = {
  database_url: {
    readers: 'every service',
    check: (v) => (/^postgres(ql)?:\/\/[^\s]+$/.test(v) ? undefined : 'must be a postgresql:// address with no spaces'),
  },
  oidc_client_secret: {
    readers: 'lims-web (hospital sign-in)',
    check: (v) => (v.length >= 8 && !/\s/.test(v) ? undefined : 'must be at least 8 characters with no spaces'),
    after: (platform) =>
      platform === 'win32'
        ? 'Set LIMS_OIDC_CLIENT_SECRET_FILE to this path in lims-web.xml if it is not set yet.'
        : 'If not done yet: systemctl edit lims-web, add "LoadCredential=oidc_client_secret:<this path>" under [Service] (11 §11).',
  },
};

/** The secrets folder the installer created (11 §3, §4). */
export function secretsDir(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  if (platform === 'win32') return join(env['ProgramData'] ?? 'C:\\ProgramData', 'LIMS Middleware', 'secrets');
  return join(env['LIMS_ETC'] ?? '/etc/lims', 'secrets');
}

export interface SetResult {
  path: string;
  replaced: boolean;
  note?: string;
}

/**
 * Write atomically: a new file beside the old one, then a rename, so a
 * service never reads half a value. On Linux the file is root-only (0600;
 * systemd hands it to the service). On Windows the value is encrypted with
 * DPAPI (machine scope) and the file takes the folder's ACL, which the
 * installer limits to the services and administrators.
 */
export function setSecret(name: string, raw: string, o: { dir?: string; platform?: NodeJS.Platform; dpapi?: DpapiRunner } = {}): SetResult {
  const spec = SECRETS[name];
  if (!spec) throw new Error(`unknown secret "${name}"; known: ${Object.keys(SECRETS).join(', ')}`);
  const value = raw.replace(/\r?\n$/, '');
  if (!value) throw new Error('no value on standard input; nothing was changed');
  const problem = spec.check(value);
  if (problem) throw new Error(`${name} ${problem}; nothing was changed`);
  const platform = o.platform ?? process.platform;
  const dir = o.dir ?? secretsDir(platform);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`${dir} does not exist: run the installer first (it creates the folder with the right permissions)`);
  const path = join(dir, name);
  const replaced = existsSync(path);
  const body = encodeSecret(name, value, { platform, ...(o.dpapi ? { dpapi: o.dpapi } : {}) });
  const tmp = join(dir, `.${name}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    writeFileSync(tmp, body, { mode: 0o600, flag: 'wx' });
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  const note = spec.after?.(platform);
  return { path, replaced, ...(note ? { note } : {}) };
}

/** Read a value without echoing it when a person types it; read all of stdin when it is a pipe or file. */
export async function readSecretInput(stdin: NodeJS.ReadStream = process.stdin, stderr: NodeJS.WriteStream = process.stderr): Promise<string> {
  if (!stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const c of stdin) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  }
  stderr.write('Type the value and press Enter (nothing is shown): ');
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const done = (fn: () => void) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      stderr.write('\n');
      fn();
    };
    const onData = (buf: Buffer) => {
      for (const ch of buf.toString('utf8')) {
        if (ch === '\r' || ch === '\n') return done(() => resolve(value));
        if (ch === '\u0003') return done(() => reject(new Error('cancelled; nothing was changed')));
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

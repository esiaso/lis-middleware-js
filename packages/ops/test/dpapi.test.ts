import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { databaseUrlFromEnv, decodeSecret, DPAPI_PREFIX, encodeSecret, isProtected, readSecretFile, type DpapiRunner } from '@lis/db';
import { parseEnvFile, setSecret, validateSource } from '@lis/ops';

/** Stands in for DPAPI on Linux: the "blob" carries the name, so a wrong name fails like the real thing. */
const fake: DpapiRunner = (op, name, data) => {
  if (op === 'protect') return Buffer.from(`${name}|${data}`).toString('base64');
  const [n, d] = Buffer.from(data, 'base64').toString().split('|');
  if (n !== name) throw new Error('DPAPI unprotect failed');
  return d as string;
};

describe('secret files (10 §7)', () => {
  let dir = '';
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it('stays a plain file on Linux and reads files written before DPAPI', () => {
    expect(encodeSecret('database_url', 'postgresql://a', { platform: 'linux', dpapi: fake })).toBe('postgresql://a\n');
    expect(decodeSecret('database_url', 'postgresql://a\n', { dpapi: fake })).toBe('postgresql://a');
  });

  it('encrypts on Windows, decrypts with the same name only', () => {
    const text = encodeSecret('oidc_client_secret', 'very secret ü', { platform: 'win32', dpapi: fake });
    expect(text.startsWith(DPAPI_PREFIX)).toBe(true);
    expect(isProtected(text)).toBe(true);
    expect(decodeSecret('oidc_client_secret', text, { dpapi: fake })).toBe('very secret ü');
    expect(() => decodeSecret('database_url', text, { dpapi: fake })).toThrow(/unprotect/);
  });

  it('lims secrets set writes the encrypted form on Windows', () => {
    dir = mkdtempSync(join(tmpdir(), 'lims-dpapi-'));
    const r = setSecret('database_url', 'postgresql://lims_app:pw@db/lims', { dir, platform: 'win32', dpapi: fake });
    const text = readFileSync(r.path, 'utf8');
    expect(text).not.toContain('pw@db');
    expect(readSecretFile('database_url', r.path, { dpapi: fake })).toBe('postgresql://lims_app:pw@db/lims');
  });

  it('config validate warns about an unencrypted secret file on Windows only', () => {
    dir = mkdtempSync(join(tmpdir(), 'lims-dpapi-'));
    const file = join(dir, 'database_url');
    writeFileSync(file, 'postgresql://plain\n');
    const src = { label: 'lims-web', path: join(dir, 'lims-web.xml'), web: true, values: parseEnvFile(`NODE_ENV=production\nDATABASE_URL_FILE=${file}`) };
    const win = validateSource(src, { platform: 'win32' });
    expect(win.find((c) => c.name === 'lims-web: DATABASE_URL_FILE')).toMatchObject({ status: 'warn', detail: expect.stringContaining('lims secrets set database_url again') });
    expect(validateSource(src, { platform: 'linux' }).filter((c) => c.status !== 'pass')).toEqual([]);
    writeFileSync(file, `${DPAPI_PREFIX}AAAA\n`);
    expect(validateSource(src, { platform: 'win32' }).filter((c) => c.status !== 'pass')).toEqual([]);
  });

  // The real thing, on the Windows CI runner: Windows PowerShell and DPAPI in machine scope.
  // Defined only on Windows rather than skipped, because the Linux database job fails on any skipped test.
  if (process.platform === 'win32') it('round-trips through Windows DPAPI and is what the services read', () => {
    dir = mkdtempSync(join(tmpdir(), 'lims-dpapi-'));
    const value = 'postgresql://lims_app:p@ss w0rd ü@db:5432/lims';
    const text = encodeSecret('database_url', value);
    expect(text.startsWith(DPAPI_PREFIX)).toBe(true);
    expect(text).not.toContain('w0rd');
    expect(decodeSecret('database_url', text)).toBe(value);
    expect(() => decodeSecret('oidc_client_secret', text)).toThrow(/DPAPI unprotect failed/);
    const file = join(dir, 'database_url');
    writeFileSync(file, text);
    expect(databaseUrlFromEnv({ DATABASE_URL_FILE: file })).toEqual({ url: value, source: `file ${file}` });
  }, 60_000); // four Windows PowerShell starts, each a second or two on a cold runner
});

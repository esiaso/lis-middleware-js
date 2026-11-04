import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildDiagBundle, collectLogs, defaultSources, parseEnvFile, parseServiceXml, redact, redactedSettings, setSecret, summariseConfig, tar, validateConfig, type ConfigSource,
} from '@lis/ops';

const src = (text: string, web = true): ConfigSource => ({ label: 'lims.env', path: '/etc/lims/lims.env', web, values: parseEnvFile(text) });
const statuses = (text: string, o?: Parameters<typeof validateConfig>[1]) =>
  Object.fromEntries(validateConfig([src(text)], o).checks.map((c) => [c.name.replace('lims.env: ', ''), `${c.status}: ${c.detail}`]));

/** Read back what tar() wrote, so the archive is checked without an external tool. */
function untar(buf: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  for (let at = 0; at + 512 <= buf.length; ) {
    const h = buf.subarray(at, at + 512);
    if (h.every((b) => b === 0)) break;
    const name = h.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    const size = Number.parseInt(h.subarray(124, 136).toString('ascii'), 8);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i]!;
    expect(Number.parseInt(h.subarray(148, 154).toString('ascii'), 8)).toBe(sum);
    expect(h.subarray(257, 262).toString('ascii')).toBe('ustar');
    out[name] = buf.subarray(at + 512, at + 512 + size).toString('utf8');
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

describe('lims config validate', () => {
  it('reads env files and service XMLs the way systemd and WinSW do', () => {
    expect([...parseEnvFile('# c\nA=1\nexport B="two words"\nC=\'x=y\'\n\n; also a comment\nnot a line\n')]).toEqual([['A', '1'], ['B', 'two words'], ['C', 'x=y'], ['!not a line', '']]);
    expect([...parseServiceXml('<service><env name="PORT" value="3000" /><!-- <env name="LIMS_OIDC_ISSUER" value="x" /> --><env name="A" value="a&amp;b"/></service>')]).toEqual([['PORT', '3000'], ['A', 'a&b']]);
  });

  it('passes the shipped example and the defaults', () => {
    const shipped = readFileSync(new URL('../../../packaging/common/lims.env.example', import.meta.url), 'utf8');
    const r = validateConfig([src(shipped)]);
    expect(r.ok).toBe(true);
    expect(r.checks).toEqual([{ name: 'lims.env', status: 'pass', detail: '5 setting(s) in /etc/lims/lims.env' }]);
    expect(summariseConfig(r)).toEqual({ name: 'settings', status: 'pass', detail: 'valid' });
  });

  it('names typos, values the services would misread, and unsafe combinations', () => {
    const s = statuses('NODE_ENV=production\nLIMS_TWO_PERSON_RUEL=true\nLIMS_TWO_PERSON_RULE=False\nPORT=0\nBIND_HOST=0.0.0.0\nLIMS_INSECURE_COOKIES=true\nDATABASE_URL=postgresql://a:b@h/d\nbroken line');
    expect(s['LIMS_TWO_PERSON_RUEL']).toBe('fail: unknown setting; nothing reads it (did you mean LIMS_TWO_PERSON_RULE?)');
    expect(s['LIMS_TWO_PERSON_RULE']).toBe('fail: must be true or false, not "False"');
    expect(s['PORT']).toMatch(/^fail/);
    expect(s['BIND_HOST']).toMatch(/^warn: listens on 0.0.0.0/);
    expect(s['LIMS_INSECURE_COOKIES']).toMatch(/^fail: is true while listening on 0.0.0.0/);
    expect(s['DATABASE_URL']).toMatch(/^warn/);
    expect(s['syntax']).toBe('fail: not KEY=VALUE: "broken line"');
    expect(JSON.stringify(s)).not.toContain('a:b@');
    expect(statuses('NODE_ENV=production\nLIMS_TWO_PERSON_RULE=false')['LIMS_TWO_PERSON_RULE']).toMatch(/^warn/);
    expect(statuses('PORT=3000')['NODE_ENV']).toBe('warn: is not set; set NODE_ENV=production on a server');
  });

  it('runs the web service\'s own hospital sign-in check, and checks files it names', () => {
    const base = 'NODE_ENV=production\nLIMS_OIDC_CLIENT_ID=lims\nLIMS_OIDC_REDIRECT_URI=https://lims.example/login/oidc/callback\nLIMS_OIDC_ROLE_MAP=LIMS-Admins=admin;LIMS-Lab=technologist\n';
    expect(statuses(base)['LIMS_OIDC_ISSUER']).toMatch(/^fail: other LIMS_OIDC_ settings are present/);
    expect(statuses(`${base}LIMS_OIDC_ISSUER=https://idp.example/realms/h`)['hospital sign-in']).toBe('pass: issuer https://idp.example/realms/h, client lims, 2 mapped group(s), no client secret in these settings (the web service also reads the credential oidc_client_secret)');
    expect(statuses(`${base}LIMS_OIDC_ISSUER=http://idp.example`)['hospital sign-in']).toBe('fail: LIMS_OIDC_ISSUER must be an https:// address');
    const leaked = statuses(`${base}LIMS_OIDC_ISSUER=https://idp.example\nLIMS_OIDC_CLIENT_SECRET=abcdefgh123`);
    expect(leaked['LIMS_OIDC_CLIENT_SECRET']).toMatch(/^warn/);
    expect(JSON.stringify(leaked)).not.toContain('abcdefgh123');
    const files = { '/ca.pem': 'not a cert', '/ok.pem': '-----BEGIN CERTIFICATE-----\nx\n' } as Record<string, string>;
    const o = { exists: (p: string) => p in files, read: (p: string) => files[p]! };
    expect(statuses('NODE_ENV=production\nNODE_EXTRA_CA_CERTS=/ca.pem', o)['NODE_EXTRA_CA_CERTS']).toMatch(/is not a PEM certificate file/);
    expect(statuses('NODE_ENV=production\nNODE_EXTRA_CA_CERTS=/ok.pem', o)['NODE_EXTRA_CA_CERTS']).toBeUndefined();
    expect(statuses('NODE_ENV=production\nDATABASE_URL_FILE=/gone', o)['DATABASE_URL_FILE']).toMatch(/^fail: \/gone does not exist/);
  });

  it('finds the settings on each platform and says plainly when they are missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lims-svc-'));
    try {
      expect(defaultSources({ platform: 'linux', etc: dir })).toMatch(/lims.env does not exist/);
      writeFileSync(join(dir, 'lims-web.xml'), '<service><env name="NODE_ENV" value="production" /><env name="PORT" value="x" /></service>');
      writeFileSync(join(dir, 'lims-jobs.xml'), '<service><env name="NODE_ENV" value="production" /><env name="PORT" value="x" /></service>');
      const sources = defaultSources({ platform: 'win32', serviceDir: dir });
      expect(Array.isArray(sources) && sources.map((s) => [s.label, s.web])).toEqual([['lims-jobs', false], ['lims-web', true]]);
      // PORT is only read by the web service.
      expect(validateConfig(sources).checks.filter((c) => c.status === 'fail').map((c) => c.name)).toEqual(['lims-web: PORT']);
      expect(validateConfig('no settings found').ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('lims secrets set', () => {
  let dir = '';
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it('writes the file the services read, replaces it whole, and refuses bad or empty values', () => {
    dir = mkdtempSync(join(tmpdir(), 'lims-sec-'));
    const first = setSecret('database_url', 'postgresql://lims_app:pw@db/lims\n', { dir, platform: 'linux' });
    expect(first).toEqual({ path: join(dir, 'database_url'), replaced: false });
    expect(readFileSync(first.path, 'utf8')).toBe('postgresql://lims_app:pw@db/lims\n');
    if (process.platform !== 'win32') expect(statSync(first.path).mode & 0o777).toBe(0o600);
    expect(setSecret('database_url', 'postgresql://lims_app:new@db/lims', { dir, platform: 'linux' }).replaced).toBe(true);
    expect(readFileSync(first.path, 'utf8')).toBe('postgresql://lims_app:new@db/lims\n');
    expect(() => setSecret('database_url', 'mysql://x', { dir })).toThrow(/postgresql/);
    expect(() => setSecret('database_url', '\n', { dir })).toThrow(/no value/);
    expect(() => setSecret('hmis_token', 'x', { dir })).toThrow(/unknown secret/);
    expect(() => setSecret('database_url', 'postgresql://x', { dir: join(dir, 'missing') })).toThrow(/run the installer first/);
    expect(setSecret('oidc_client_secret', 's3cret-value', { dir, platform: 'linux' }).note).toMatch(/LoadCredential=oidc_client_secret/);
    expect(setSecret('oidc_client_secret', 's3cret-value', { dir, platform: 'win32', dpapi: (_op, _n, d) => d }).note).toMatch(/LIMS_OIDC_CLIENT_SECRET_FILE/);
  });
});

describe('lims diag bundle', () => {
  let dir = '';
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it('removes credentials from text and settings', () => {
    expect(redact('connect postgresql://lims:p%40ss@db:5432/lims failed')).toBe('connect postgresql://lims:[removed]@db:5432/lims failed');
    expect(redact('Authorization: Bearer eyJhbGciOi.abc.def')).toBe('Authorization: Bearer [removed]');
    expect(redact('{"password":"x\\"y","clientSecret":"z","ok":"keep"}')).toBe('{"password":"[removed]","clientSecret":"[removed]","ok":"keep"}');
    expect(redactedSettings([src('DATABASE_URL=postgresql://a:b@h/d\nLIMS_OIDC_CLIENT_SECRET=zzz\nPORT=3000')])).toBe('# lims.env: /etc/lims/lims.env\nDATABASE_URL=[removed]\nLIMS_OIDC_CLIENT_SECRET=[removed]\nPORT=3000\n');
  });

  it('builds one archive with reports, settings and log tails, and names what it could not collect', () => {
    dir = mkdtempSync(join(tmpdir(), 'lims-logs-'));
    writeFileSync(join(dir, 'lims-web.out.log'), `${'old line\n'.repeat(10)}{"err":"postgresql://u:pw@h/d down","password":"hunter2"}\n`);
    writeFileSync(join(dir, 'lims-web.exe'), 'not a log');
    mkdirSync(join(dir, 'sub'));
    const logs = collectLogs({ logDir: dir });
    expect(Array.isArray(logs) && logs.map((l) => l.name)).toEqual(['logs/lims-web.out.log']);
    expect(collectLogs({ logDir: join(dir, 'none') })).toMatch(/no log folder/);

    const b = buildDiagBundle({ verify: 'RESULT: PASS\n', status: undefined, settings: [src('PORT=3000\nDATABASE_URL=postgresql://a:secretpw@h/d')], logs, version: '0.1.0', now: new Date('2026-11-04T10:00:00Z') });
    expect(b.file).toMatch(/^lims-diag-.+-20261104T100000Z\.tar\.gz$/);
    expect(b.missing).toEqual(['status.txt: the database could not be reached']);
    const files = untar(gunzipSync(b.data));
    const names = Object.keys(files).map((n) => n.slice(n.indexOf('/') + 1));
    expect(names).toEqual(['README.txt', 'verify.txt', 'settings.txt', 'logs/lims-web.out.log']);
    const all = Object.values(files).join('\n');
    expect(all).not.toContain('hunter2');
    expect(all).not.toContain('secretpw');
    expect(all).not.toContain(':pw@');
    expect(all).toContain('Not collected:\n  status.txt: the database could not be reached');
    expect(all).toContain('version: 0.1.0');
  });

  it('writes valid ustar entries', () => {
    const t = tar([{ name: 'a/b.txt', body: Buffer.from('x'.repeat(700)), mtime: new Date(0) }]);
    expect(t.length).toBe(512 + 1024 + 1024);
    expect(untar(t)['a/b.txt']).toHaveLength(700);
    expect(() => tar([{ name: 'n'.repeat(120), body: Buffer.alloc(0), mtime: new Date(0) }])).toThrow(/too long/);
  });
});

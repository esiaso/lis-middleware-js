import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { isProtected } from '@lis/db';
import { fhirHmisSettingsFromEnv } from '@lis/hmis';
import { ldapSettingsFromEnv } from '@lis/web/ldap';
import { oidcSettingsFromEnv } from '@lis/web/oidc';
import type { Check } from './verify.js';

/**
 * `lims config validate` (11 §2.1): read the settings each service will
 * start with and say plainly what is wrong, before anything is started.
 * Settings are environment variables: /etc/lims/lims.env on Linux, the
 * <env> entries of each WinSW XML on Windows. Values are never printed for
 * keys that hold secrets.
 */

/** One source of settings: a file and the services that read it. */
export interface ConfigSource {
  label: string;
  path: string;
  /** Which settings apply: the web service reads them all; the others need only the database and Node ones. */
  web: boolean;
  /** The jobs worker's settings, where the HMIS link is configured. */
  jobs?: boolean;
  values: Map<string, string>;
}

/** systemd EnvironmentFile syntax: KEY=VALUE, comments, optional single or double quotes. */
export function parseEnvFile(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) {
      out.set(`!${line.slice(0, 40)}`, '');
      continue;
    }
    let v = m[2] as string;
    if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) v = v.slice(1, -1);
    out.set(m[1] as string, v);
  }
  return out;
}

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** The <env name="" value=""/> entries of a WinSW service XML, outside comments. */
export function parseServiceXml(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const live = text.replace(/<!--[\s\S]*?-->/g, '');
  const unescape = (s: string) => s.replace(/&(amp|lt|gt|quot|apos);/g, (_, e: string) => XML_ENTITIES[e] as string);
  for (const m of live.matchAll(/<env\s+name="([^"]*)"\s+value="([^"]*)"\s*\/>/g)) out.set(unescape(m[1] as string), unescape(m[2] as string));
  return out;
}

/** Where this server keeps its settings. */
export function defaultSources(o: { platform?: NodeJS.Platform; etc?: string; serviceDir?: string | undefined } = {}): ConfigSource[] | string {
  const platform = o.platform ?? process.platform;
  if (platform === 'win32') {
    const dir = o.serviceDir;
    if (!dir || !existsSync(dir)) return `no service folder${dir ? ` at ${dir}` : ''}: run from the installed bundle, or pass --service-dir`;
    const files = readdirSync(dir).filter((f) => /^lims-.*\.xml$/.test(f)).sort();
    if (!files.length) return `no lims-*.xml service files in ${dir}`;
    return files.map((f) => ({ label: f.replace(/\.xml$/, ''), path: join(dir, f), web: f === 'lims-web.xml', jobs: f === 'lims-jobs.xml', values: parseServiceXml(readFileSync(join(dir, f), 'utf8')) }));
  }
  const path = join(o.etc ?? '/etc/lims', 'lims.env');
  if (!existsSync(path)) return `${path} does not exist: run scripts/install.sh first, or pass --env-file`;
  return [{ label: 'lims.env (all services)', path, web: true, jobs: true, values: parseEnvFile(readFileSync(path, 'utf8')) }];
}

const OIDC_KEYS = [
  'LIMS_OIDC_ISSUER', 'LIMS_OIDC_CLIENT_ID', 'LIMS_OIDC_CLIENT_SECRET', 'LIMS_OIDC_CLIENT_SECRET_FILE', 'LIMS_OIDC_REDIRECT_URI', 'LIMS_OIDC_ROLE_MAP',
  'LIMS_OIDC_SCOPES', 'LIMS_OIDC_USERNAME_CLAIM', 'LIMS_OIDC_DISPLAY_NAME_CLAIM', 'LIMS_OIDC_GROUPS_CLAIM', 'LIMS_OIDC_LABEL', 'LIMS_OIDC_PROMPT_LOGIN',
];
/** Same check as the web service makes at start (domain isTimeZone): a name Node's time zone data knows. */
function isTimeZone(tz: string): boolean {
  try {
    return tz.length > 0 && tz.length <= 64 && !!new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    return false;
  }
}
/** Every LIMS_* setting the services read. A LIMS_ key not listed here is a typo. */
const LDAP_KEYS = [
  'LIMS_LDAP_URL', 'LIMS_LDAP_CA_FILE', 'LIMS_LDAP_BIND_DN', 'LIMS_LDAP_BIND_PASSWORD', 'LIMS_LDAP_BIND_PASSWORD_FILE', 'LIMS_LDAP_BASE_DN', 'LIMS_LDAP_USER_FILTER',
  'LIMS_LDAP_ID_ATTRIBUTE', 'LIMS_LDAP_DISPLAY_NAME_ATTRIBUTE', 'LIMS_LDAP_GROUP_ATTRIBUTE', 'LIMS_LDAP_ROLE_MAP', 'LIMS_LDAP_LABEL', 'LIMS_LDAP_TIMEOUT_MS',
];
const HMIS_KEYS = [
  'LIMS_HMIS_PROFILE', 'LIMS_HMIS_BASE_URL', 'LIMS_HMIS_TOKEN_URL', 'LIMS_HMIS_CLIENT_ID', 'LIMS_HMIS_CLIENT_SECRET', 'LIMS_HMIS_CLIENT_SECRET_FILE', 'LIMS_HMIS_SCOPES',
  'LIMS_HMIS_PAGE_SIZE', 'LIMS_HMIS_TIMEOUT_MS', 'LIMS_HMIS_POLL_SECONDS', 'LIMS_HMIS_MRN_SYSTEM', 'LIMS_HMIS_ORDER_SYSTEM', 'LIMS_HMIS_ORDER_LINE_SYSTEM', 'LIMS_HMIS_TEST_SYSTEM',
  'LIMS_HMIS_LIMS_SYSTEM_PREFIX',
];
export const KNOWN_LIMS_KEYS = ['LIMS_TWO_PERSON_RULE', 'LIMS_INSECURE_COOKIES', 'LIMS_HOME', 'LIMS_REPORT_HEADER', 'LIMS_TIME_ZONE', 'LIMS_AUDIT_SIGNING_KEY_FILE', ...OIDC_KEYS, ...LDAP_KEYS, ...HMIS_KEYS];
/** Keys whose values are never shown. */
export const SECRET_KEY = /SECRET|PASSWORD|TOKEN|PRIVATE|^DATABASE_URL$/i;

function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length]![b.length]!;
}

const LOOPBACK = (h: string) => h === 'localhost' || h === '::1' || /^127\./.test(h);
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;

/** Check one source. `exists` is replaceable for tests. */
export function validateSource(src: ConfigSource, o: { exists?: (p: string) => boolean; read?: (p: string) => string; platform?: NodeJS.Platform } = {}): Check[] {
  const exists = o.exists ?? existsSync;
  const windows = (o.platform ?? process.platform) === 'win32';
  const read = o.read ?? ((p: string) => readFileSync(p, 'utf8'));
  const v = src.values;
  const issues: Check[] = [];
  const add = (status: Check['status'], name: string, detail: string) => issues.push({ name: `${src.label}: ${name}`, status, detail });

  for (const k of v.keys()) {
    if (k.startsWith('!')) add('fail', 'syntax', `not KEY=VALUE: "${k.slice(1)}"`);
    else if (k.startsWith('LIMS_') && !KNOWN_LIMS_KEYS.includes(k)) {
      const near = KNOWN_LIMS_KEYS.map((x) => [x, distance(k, x)] as const).sort((a, b) => a[1] - b[1])[0]!;
      add('fail', k, `unknown setting; nothing reads it${near[1] <= 3 ? ` (did you mean ${near[0]}?)` : ''}`);
    }
  }
  for (const k of ['LIMS_TWO_PERSON_RULE', 'LIMS_INSECURE_COOKIES', 'LIMS_OIDC_PROMPT_LOGIN']) {
    const x = v.get(k);
    // The services compare with exact strings, so "True" or "yes" would silently mean the default.
    if (x !== undefined && x !== 'true' && x !== 'false') add('fail', k, `must be true or false, not "${x}"`);
  }
  const tz = v.get('LIMS_TIME_ZONE');
  if (tz !== undefined && !isTimeZone(tz.trim())) add('fail', 'LIMS_TIME_ZONE', `"${tz.slice(0, 64)}" is not a time zone name such as Africa/Nairobi; the web service will not start`);
  if ((v.get('LIMS_REPORT_HEADER') ?? '').length > 120) add('warn', 'LIMS_REPORT_HEADER', 'is longer than 120 characters; the report shows only the first 120');
  if (v.get('NODE_ENV') !== 'production') add('warn', 'NODE_ENV', `is ${v.has('NODE_ENV') ? `"${v.get('NODE_ENV')}"` : 'not set'}; set NODE_ENV=production on a server`);
  if (v.has('DATABASE_URL')) add('warn', 'DATABASE_URL', 'the database password is in the settings; move it to the credential file (lims secrets set database_url) and remove this line');
  const dbFile = v.get('DATABASE_URL_FILE');
  // On Windows a secret file should hold a DPAPI blob (10 §7); one written before DPAPI still works but is readable by any administrator, and from a copy.
  const plainSecret = (key: string, name: string, file: string | undefined): void => {
    if (file === undefined || !exists(file) || !windows) return;
    let text: string;
    try {
      text = read(file);
    } catch (e) {
      add('fail', key, `${file} cannot be read: ${(e as Error).message}`);
      return;
    }
    if (!isProtected(text)) add('warn', key, `${file} is not encrypted; run lims secrets set ${name} again to store it with DPAPI`);
  };
  if (dbFile !== undefined && !exists(dbFile)) add('fail', 'DATABASE_URL_FILE', `${dbFile} does not exist (lims secrets set database_url)`);
  plainSecret('DATABASE_URL_FILE', 'database_url', dbFile);
  const ca = v.get('NODE_EXTRA_CA_CERTS');
  if (ca !== undefined) {
    if (!exists(ca)) add('fail', 'NODE_EXTRA_CA_CERTS', `${ca} does not exist`);
    else if (!read(ca).includes('-----BEGIN CERTIFICATE-----')) add('fail', 'NODE_EXTRA_CA_CERTS', `${ca} is not a PEM certificate file`);
  }

  if (src.web) {
    const port = v.get('PORT');
    if (port !== undefined && !(/^\d{1,5}$/.test(port) && Number(port) >= 1 && Number(port) <= 65535)) add('fail', 'PORT', `must be a port number from 1 to 65535, not "${port}"`);
    const host = v.get('BIND_HOST') ?? '127.0.0.1';
    if (!isIP(host) && !HOSTNAME.test(host)) add('fail', 'BIND_HOST', `"${host}" is not an address or host name`);
    else if (!LOOPBACK(host)) add('warn', 'BIND_HOST', `listens on ${host}; the hospital reverse proxy should be the only way in (11 §4), so 127.0.0.1 is expected`);
    if (v.get('LIMS_INSECURE_COOKIES') === 'true') {
      if (LOOPBACK(host)) add('warn', 'LIMS_INSECURE_COOKIES', 'is true: cookies are sent without TLS protection; for a loopback-only test setup only');
      else add('fail', 'LIMS_INSECURE_COOKIES', `is true while listening on ${host}: session cookies would cross the network unprotected`);
    }
    const keyFile = v.get('LIMS_AUDIT_SIGNING_KEY_FILE');
    if (keyFile !== undefined && !exists(keyFile)) add('fail', 'LIMS_AUDIT_SIGNING_KEY_FILE', `${keyFile} does not exist (lims audit keygen); the web service will not start`);
    plainSecret('LIMS_AUDIT_SIGNING_KEY_FILE', 'audit_signing_key', keyFile);
    if (v.get('LIMS_TWO_PERSON_RULE') === 'false') add('warn', 'LIMS_TWO_PERSON_RULE', 'is false: one person may review and approve the same result (10 §2); needs the lab director\'s written agreement');
    const anyOidc = OIDC_KEYS.some((k) => v.has(k));
    if (anyOidc && !v.has('LIMS_OIDC_ISSUER')) add('fail', 'LIMS_OIDC_ISSUER', 'other LIMS_OIDC_ settings are present but LIMS_OIDC_ISSUER is not, so hospital sign-in stays off');
    else if (v.has('LIMS_OIDC_ISSUER')) {
      const secretFile = v.get('LIMS_OIDC_CLIENT_SECRET_FILE');
      plainSecret('LIMS_OIDC_CLIENT_SECRET_FILE', 'oidc_client_secret', secretFile);
      if (v.has('LIMS_OIDC_CLIENT_SECRET')) add('warn', 'LIMS_OIDC_CLIENT_SECRET', 'the client secret is in the settings; store it with lims secrets set oidc_client_secret instead');
      try {
        // The same code the web service runs at start, with only these settings.
        const s = oidcSettingsFromEnv(Object.fromEntries(v));
        if (s) add('pass', 'hospital sign-in', `issuer ${s.issuer.href}, client ${s.clientId}, ${s.roleMap.size} mapped group(s)${s.clientSecret ? ', client secret found' : ', no client secret in these settings (the web service also reads the credential oidc_client_secret)'}`);
      } catch (e) {
        add('fail', 'hospital sign-in', (e as Error).message);
      }
    }
    const anyLdap = LDAP_KEYS.some((k) => v.has(k));
    if (anyLdap && !v.has('LIMS_LDAP_URL')) add('fail', 'LIMS_LDAP_URL', 'other LIMS_LDAP_ settings are present but LIMS_LDAP_URL is not, so directory sign-in stays off');
    else if (v.has('LIMS_LDAP_URL')) {
      const secretFile = v.get('LIMS_LDAP_BIND_PASSWORD_FILE');
      plainSecret('LIMS_LDAP_BIND_PASSWORD_FILE', 'ldap_bind_password', secretFile);
      if (v.has('LIMS_LDAP_BIND_PASSWORD')) add('warn', 'LIMS_LDAP_BIND_PASSWORD', 'the service account password is in the settings; store it with lims secrets set ldap_bind_password instead');
      const caFile = v.get('LIMS_LDAP_CA_FILE');
      if (caFile !== undefined && !exists(caFile)) add('fail', 'LIMS_LDAP_CA_FILE', `${caFile} does not exist`);
      else if (caFile !== undefined && !read(caFile).includes('-----BEGIN CERTIFICATE-----')) add('fail', 'LIMS_LDAP_CA_FILE', `${caFile} is not a PEM certificate file`);
      else {
        // The web service's own check. On Linux the password comes as a systemd credential this check cannot see.
        const hasPassword = v.has('LIMS_LDAP_BIND_PASSWORD') || secretFile !== undefined;
        const env = Object.fromEntries(v);
        if (!hasPassword) env['LIMS_LDAP_BIND_PASSWORD'] = 'checked-by-the-service';
        if (secretFile !== undefined) {
          delete env['LIMS_LDAP_BIND_PASSWORD_FILE'];
          env['LIMS_LDAP_BIND_PASSWORD'] = 'checked-above';
        }
        delete env['LIMS_LDAP_CA_FILE'];
        try {
          const s = ldapSettingsFromEnv(env);
          if (s) add('pass', 'directory sign-in', `${s.url.href}, base ${s.baseDn}, ${s.roleMap.size} mapped group(s)${caFile ? ', CA file found' : ''}${hasPassword ? '' : ', no service account password in these settings (the web service also reads the credential ldap_bind_password)'}`);
        } catch (e) {
          add('fail', 'directory sign-in', (e as Error).message);
        }
      }
    }
  }

  if (src.jobs) {
    const anyHmis = HMIS_KEYS.some((k) => v.has(k));
    if (anyHmis && !v.has('LIMS_HMIS_PROFILE')) add('fail', 'LIMS_HMIS_PROFILE', 'other LIMS_HMIS_ settings are present but LIMS_HMIS_PROFILE is not, so the HMIS link stays off');
    else if (v.has('LIMS_HMIS_PROFILE')) {
      const secretFile = v.get('LIMS_HMIS_CLIENT_SECRET_FILE');
      plainSecret('LIMS_HMIS_CLIENT_SECRET_FILE', 'hmis_client_secret', secretFile);
      if (secretFile !== undefined && !exists(secretFile)) add('fail', 'LIMS_HMIS_CLIENT_SECRET_FILE', `${secretFile} does not exist (lims secrets set hmis_client_secret)`);
      if (v.has('LIMS_HMIS_CLIENT_SECRET')) add('warn', 'LIMS_HMIS_CLIENT_SECRET', 'the client secret is in the settings; store it with lims secrets set hmis_client_secret instead');
      // The jobs worker's own check. On Linux the secret comes as a systemd credential this check cannot see.
      const hasSecret = v.has('LIMS_HMIS_CLIENT_SECRET') || secretFile !== undefined;
      const env = Object.fromEntries(v);
      delete env['LIMS_HMIS_CLIENT_SECRET_FILE'];
      env['LIMS_HMIS_CLIENT_SECRET'] = 'checked-elsewhere';
      try {
        const s = fhirHmisSettingsFromEnv(env);
        const poll = v.get('LIMS_HMIS_POLL_SECONDS');
        if (poll !== undefined && !(/^\d+$/.test(poll) && Number(poll) >= 10 && Number(poll) <= 3600)) add('fail', 'LIMS_HMIS_POLL_SECONDS', 'must be a whole number of seconds from 10 to 3600');
        if (s) add('pass', 'HMIS link', `FHIR R4 at ${s.baseUrl.href}, client ${s.clientId}, ${s.pageSize} orders a page${hasSecret ? '' : ', no client secret in these settings (the jobs worker also reads the credential hmis_client_secret)'}`);
      } catch (e) {
        add('fail', 'HMIS link', (e as Error).message);
      }
    }
  }
  return issues;
}

export interface ConfigReport {
  checks: Check[];
  ok: boolean;
}

export function validateConfig(sources: ConfigSource[] | string, o: Parameters<typeof validateSource>[1] = {}): ConfigReport {
  if (typeof sources === 'string') return { checks: [{ name: 'settings', status: 'fail', detail: sources }], ok: false };
  const checks: Check[] = [];
  for (const s of sources) {
    const found = validateSource(s, o);
    checks.push(...found);
    if (!found.some((c) => c.status === 'fail' || c.status === 'warn')) checks.push({ name: s.label, status: 'pass', detail: `${s.values.size} setting(s) in ${s.path}` });
  }
  return { checks, ok: checks.every((c) => c.status !== 'fail') };
}

/** One line for `lims verify`: the worst result, with counts. */
export function summariseConfig(r: ConfigReport): Check {
  const fails = r.checks.filter((c) => c.status === 'fail');
  const warns = r.checks.filter((c) => c.status === 'warn');
  if (fails.length) return { name: 'settings', status: 'fail', detail: `${fails.length} problem(s), first: ${fails[0]!.name} ${fails[0]!.detail} (lims config validate)` };
  if (warns.length) return { name: 'settings', status: 'warn', detail: `${warns.length} warning(s) (lims config validate)` };
  return { name: 'settings', status: 'pass', detail: 'valid' };
}

/** Same layout as `lims verify`. */
export function formatChecks(title: string, checks: Check[], ok: boolean): string {
  const width = Math.max(...checks.map((c) => c.name.length), 4);
  return [title, '', ...checks.map((c) => `${c.status.toUpperCase().padEnd(4)}  ${c.name.padEnd(width)}  ${c.detail}`), '', ok ? 'RESULT: PASS' : 'RESULT: FAIL', ''].join('\n');
}

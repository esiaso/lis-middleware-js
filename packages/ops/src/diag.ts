import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { SECRET_KEY, type ConfigSource } from './config.js';

/**
 * `lims diag bundle` (11 §7): one .tar.gz to send to support, built on the
 * server itself. It holds the verify and status reports, the settings with
 * secret values removed, and recent service logs with credentials removed.
 * Logs can still hold identifiers from error messages, so the bundle is
 * handled under the hospital's data agreement with whoever receives it.
 */

/** Credentials that may appear in text: URL passwords, bearer tokens, JSON fields named like secrets. */
export function redact(text: string): string {
  return text
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@"']+:)[^\s@"']+@/gi, '$1[removed]@')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, '$1 [removed]')
    .replace(/("[^"]*(?:password|secret|token|authorization|cookie)[^"]*"\s*:\s*)"(?:[^"\\]|\\.)*"/gi, '$1"[removed]"');
}

/** The settings as a file, one KEY=VALUE per line, with secret values removed. */
export function redactedSettings(sources: ConfigSource[]): string {
  return sources
    .map((s) => [`# ${s.label}: ${s.path}`, ...[...s.values].filter(([k]) => !k.startsWith('!')).map(([k, v]) => `${k}=${SECRET_KEY.test(k) ? '[removed]' : redact(v)}`)].join('\n'))
    .join('\n\n') + '\n';
}

/** Minimal POSIX ustar writer: regular files only, fixed owner and mode, names under 100 bytes. */
export function tar(files: { name: string; body: Buffer; mtime: Date }[]): Buffer {
  const blocks: Buffer[] = [];
  for (const f of files) {
    const h = Buffer.alloc(512);
    const name = Buffer.from(f.name, 'utf8');
    if (name.length > 99) throw new Error(`name too long for the archive: ${f.name}`);
    name.copy(h, 0);
    const octal = (n: number, width: number) => n.toString(8).padStart(width - 1, '0') + '\0';
    h.write(octal(0o644, 8), 100, 'ascii');
    h.write(octal(0, 8), 108, 'ascii');
    h.write(octal(0, 8), 116, 'ascii');
    h.write(octal(f.body.length, 12), 124, 'ascii');
    h.write(octal(Math.floor(f.mtime.getTime() / 1000), 12), 136, 'ascii');
    h.fill(' ', 148, 156);
    h.write('0', 156, 'ascii');
    h.write('ustar\u000000', 257, 'ascii');
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
    blocks.push(h, f.body, Buffer.alloc((512 - (f.body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

/** The last `max` bytes of a file, starting at a line break. */
export function tail(path: string, max: number): Buffer {
  const size = statSync(path).size;
  const start = Math.max(0, size - max);
  const buf = Buffer.alloc(size - start);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buf, 0, buf.length, start);
  } finally {
    closeSync(fd);
  }
  if (start === 0) return buf;
  const nl = buf.indexOf(0x0a);
  return nl >= 0 ? buf.subarray(nl + 1) : buf;
}

export const LOG_BYTES = 5 * 1024 * 1024;
const LOG_FILES = 20;

/** Recent service logs: journald on Linux, WinSW log files on Windows. */
export function collectLogs(o: { platform?: NodeJS.Platform; logDir?: string; since?: string } = {}): { name: string; body: Buffer }[] | string {
  const platform = o.platform ?? process.platform;
  if (platform === 'win32' || o.logDir) {
    const dir = o.logDir ?? join(process.env['ProgramData'] ?? 'C:\\ProgramData', 'LIMS Middleware', 'logs');
    if (!existsSync(dir)) return `no log folder at ${dir}`;
    const files = readdirSync(dir)
      .filter((f) => /\.(log|txt)$/i.test(f))
      .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
      .slice(0, LOG_FILES);
    return files.map(({ f }) => ({ name: `logs/${f}`, body: Buffer.from(redact(tail(join(dir, f), LOG_BYTES).toString('utf8'))) }));
  }
  const r = spawnSync('journalctl', ['-u', 'lims-web', '-u', 'lims-jobs', '-u', 'lims-analyzer@*', '--since', o.since ?? '-48h', '-o', 'short-iso', '--no-pager'], { maxBuffer: 64 * 1024 * 1024 });
  if (r.error || r.status !== 0) return `journalctl failed: ${r.error?.message ?? r.stderr.toString().trim()}`;
  const out = r.stdout.length > LOG_BYTES * 4 ? r.stdout.subarray(r.stdout.length - LOG_BYTES * 4) : r.stdout;
  return [{ name: 'logs/journal.txt', body: Buffer.from(redact(out.toString('utf8'))) }];
}

export interface DiagParts {
  verify: string;
  status: string | undefined;
  settings: ConfigSource[] | string;
  logs: { name: string; body: Buffer }[] | string;
  version: string | undefined;
  now?: Date;
}

/** Assemble the archive. Every part that could not be collected is named in README.txt, not silently left out. */
export function buildDiagBundle(p: DiagParts): { file: string; data: Buffer; missing: string[] } {
  const now = p.now ?? new Date();
  const stamp = now.toISOString().replace(/[-:]/g, '').slice(0, 15);
  const base = `lims-diag-${hostname().replace(/[^A-Za-z0-9.-]/g, '_').slice(0, 20)}-${stamp}Z`;
  const missing: string[] = [];
  const files: { name: string; body: Buffer }[] = [{ name: 'verify.txt', body: Buffer.from(p.verify) }];
  if (p.status !== undefined) files.push({ name: 'status.txt', body: Buffer.from(p.status) });
  else missing.push('status.txt: the database could not be reached');
  if (typeof p.settings === 'string') missing.push(`settings.txt: ${p.settings}`);
  else files.push({ name: 'settings.txt', body: Buffer.from(redactedSettings(p.settings)) });
  if (typeof p.logs === 'string') missing.push(`logs: ${p.logs}`);
  else files.push(...p.logs);
  const readme = [
    `LIMS middleware diagnostic bundle from ${hostname()} at ${now.toISOString()}`,
    `version: ${p.version ?? 'not a release bundle'}`,
    '',
    'Secret values (database password, client secrets, tokens) were removed before',
    'this file was written. Logs may still contain specimen or patient identifiers',
    'from error messages: send it only under the hospital\'s data agreement.',
    '',
    'Contents:',
    ...files.map((f) => `  ${f.name} (${f.body.length} bytes)`),
    ...(missing.length ? ['', 'Not collected:', ...missing.map((m) => `  ${m}`)] : []),
    '',
  ].join('\n');
  const entries = [{ name: 'README.txt', body: Buffer.from(readme) }, ...files].map((f) => ({ name: `${base}/${f.name}`, body: f.body, mtime: now }));
  return { file: `${base}.tar.gz`, data: gzipSync(tar(entries)), missing };
}

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * Secret files on Windows are encrypted with DPAPI in machine scope (10 §7):
 * a copy of the file taken off the server (a backup, a disk image) cannot be
 * decrypted elsewhere. On the server itself the folder's ACL is what limits
 * readers to the services and administrators. No native module: Windows
 * PowerShell 5.1, present on every supported Windows Server, does the DPAPI
 * call, and the value travels on its standard input and output only, never
 * on a command line.
 */

export const DPAPI_PREFIX = 'lims-dpapi:1:';

/** Ties a blob to its purpose, so a database_url blob cannot be passed off as another secret. */
const entropy = (name: string) => `lims-middleware/${name}`;

/** Runs the PowerShell DPAPI call. Replaceable in tests. */
export type DpapiRunner = (op: 'protect' | 'unprotect', name: string, data: string) => string;

const SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$in = [Console]::In.ReadToEnd().Split([char]10)
$op = $in[0].Trim(); $ent = [Text.Encoding]::UTF8.GetBytes($in[1].Trim()); $data = $in[2].Trim()
$scope = [Security.Cryptography.DataProtectionScope]::LocalMachine
if ($op -eq 'protect') {
  $b = [Security.Cryptography.ProtectedData]::Protect([Convert]::FromBase64String($data), $ent, $scope)
} else {
  $b = [Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($data), $ent, $scope)
}
[Console]::Out.Write([Convert]::ToBase64String($b))
`;

export const powershellDpapi: DpapiRunner = (op, name, data) => {
  const root = process.env['SystemRoot'] ?? 'C:\\Windows';
  const exe = `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  // The script goes in as -EncodedCommand (UTF-16LE base64); the secret goes on stdin.
  const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64');
  const r = spawnSync(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
    input: `${op}\n${entropy(name)}\n${data}\n`,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
  });
  if (r.error) throw new Error(`DPAPI ${op} failed: ${r.error.message}`);
  // stderr can hold CLIXML progress noise; only the exit code and stdout count.
  if (r.status !== 0 || !r.stdout.trim()) throw new Error(`DPAPI ${op} failed (exit ${r.status}); the file was written on another server or for another name`);
  return r.stdout.trim();
};

/** The text to write to a secret file: encrypted on Windows, the value itself elsewhere. */
export function encodeSecret(name: string, value: string, o: { platform?: NodeJS.Platform; dpapi?: DpapiRunner } = {}): string {
  if ((o.platform ?? process.platform) !== 'win32') return `${value}\n`;
  const blob = (o.dpapi ?? powershellDpapi)('protect', name, Buffer.from(value, 'utf8').toString('base64'));
  return `${DPAPI_PREFIX}${blob}\n`;
}

/** The value from a secret file's text, decrypting a DPAPI blob. A plain file (Linux, or written before DPAPI) is read as is. */
export function decodeSecret(name: string, text: string, o: { dpapi?: DpapiRunner } = {}): string {
  const t = text.trim();
  if (!t.startsWith(DPAPI_PREFIX)) return t;
  const plain = (o.dpapi ?? powershellDpapi)('unprotect', name, t.slice(DPAPI_PREFIX.length));
  return Buffer.from(plain, 'base64').toString('utf8');
}

export const isProtected = (text: string) => text.trimStart().startsWith(DPAPI_PREFIX);

/** Read one secret file. `name` is the secret's name (database_url, oidc_client_secret), part of the DPAPI entropy. */
export function readSecretFile(name: string, path: string, o: { dpapi?: DpapiRunner } = {}): string {
  return decodeSecret(name, readFileSync(path, 'utf8'), o);
}

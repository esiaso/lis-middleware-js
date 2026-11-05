import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readSecretFile } from '@lis/db';
import { auditSignerFromPem, type AuditSigner } from '@lis/lab';

/**
 * Where the audit signing key comes from (01 A-16, 11 §11): the systemd
 * credential audit_signing_key (Linux) or the file in
 * LIMS_AUDIT_SIGNING_KEY_FILE (Windows, DPAPI-encrypted). Read at each use,
 * so a new key needs no restart. Undefined when none is set: exports are
 * then unsigned, and say so.
 */
export type AuditKeySource = () => string | undefined;

export function auditKeySourceFromEnv(env: NodeJS.ProcessEnv = process.env): AuditKeySource | undefined {
  const dir = env['CREDENTIALS_DIRECTORY'];
  const file = env['LIMS_AUDIT_SIGNING_KEY_FILE']?.trim();
  if (file) return () => readSecretFile('audit_signing_key', file);
  if (dir && existsSync(join(dir, 'audit_signing_key'))) return () => readFileSync(join(dir, 'audit_signing_key'), 'utf8');
  return undefined;
}

/** Null when no key is set. Throws when a key is set but cannot be used, so an export is never silently unsigned. */
export function auditSigner(source: AuditKeySource | undefined): AuditSigner | null {
  if (!source) return null;
  let pem: string | undefined;
  try {
    pem = source();
  } catch (e) {
    throw new Error(`the audit signing key cannot be read: ${(e as Error).message}`);
  }
  if (!pem?.trim()) throw new Error('the audit signing key file is empty');
  return auditSignerFromPem(pem);
}

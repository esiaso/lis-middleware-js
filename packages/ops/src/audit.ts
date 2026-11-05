import { generateKeyPairSync } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DpapiRunner } from '@lis/db';
import { auditSignerFromPem, verifyAuditExport, type ExportCheck } from '@lis/lab';
import { secretsDir, setSecret } from './secrets.js';

/**
 * `lims audit keygen` (01 A-16, 11 §11): make the Ed25519 key that signs
 * audit exports, on the hospital's server. The private key goes straight
 * into the secrets folder (DPAPI-encrypted on Windows) and is never shown;
 * the public key is printed for hospital IT security to keep, because it is
 * what proves later that an export came from this server unchanged.
 */
export function generateAuditKey(o: { dir?: string; platform?: NodeJS.Platform; dpapi?: DpapiRunner; replace?: boolean } = {}): { keyId: string; publicKeyPem: string; path: string; note?: string } {
  const platform = o.platform ?? process.platform;
  const dir = o.dir ?? secretsDir(platform);
  if (existsSync(join(dir, 'audit_signing_key')) && !o.replace) {
    throw new Error(`${join(dir, 'audit_signing_key')} exists. A new key cannot check exports signed with the old one, so keep the old public key; add --replace to make a new key anyway`);
  }
  const { privateKey } = generateKeyPairSync('ed25519');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const signer = auditSignerFromPem(pem);
  const r = setSecret('audit_signing_key', pem, { dir, platform, ...(o.dpapi ? { dpapi: o.dpapi } : {}) });
  return { keyId: signer.keyId, publicKeyPem: signer.publicKeyPem, path: r.path, ...(r.note ? { note: r.note } : {}) };
}

/** `lims audit verify-export <file> [--public-key <file>]`: the export checked on its own, without the database. */
export function verifyExportFile(file: string, publicKeyFile?: string): { ok: boolean; checks: ExportCheck[] } {
  const text = readFileSync(file, 'utf8');
  const publicKeyPem = publicKeyFile ? readFileSync(publicKeyFile, 'utf8') : undefined;
  return verifyAuditExport(text, publicKeyPem ? { publicKeyPem } : {});
}

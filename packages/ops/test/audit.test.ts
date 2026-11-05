import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AUDIT_GENESIS, auditExportLine, auditExportTrailer, auditSignerFromPem, eventHash } from '@lis/lab';
import { generateAuditKey, setSecret, verifyExportFile } from '@lis/ops';
import { auditKeySourceFromEnv, auditSigner } from '../../web/src/audit-signing.js';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'lims-audit-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('lims audit keygen and verify-export', () => {
  it('stores a new key unseen, prints its public half, and will not replace it by accident', () => {
    const dir = tmp();
    const k = generateAuditKey({ dir, platform: 'linux' });
    expect(k.publicKeyPem).toContain('-----BEGIN PUBLIC KEY-----');
    expect(k.keyId).toMatch(/^[0-9a-f]{16}$/);
    const stored = readFileSync(join(dir, 'audit_signing_key'), 'utf8');
    expect(stored).toContain('-----BEGIN PRIVATE KEY-----');
    // Windows has no POSIX modes; the secrets folder's ACL limits readers there.
    if (process.platform !== 'win32') expect(statSync(join(dir, 'audit_signing_key')).mode & 0o777).toBe(0o600);
    expect(auditSignerFromPem(stored).keyId).toBe(k.keyId);
    expect(k.note).toMatch(/LoadCredential=audit_signing_key/);
    expect(() => generateAuditKey({ dir, platform: 'linux' })).toThrow(/--replace/);
    expect(generateAuditKey({ dir, platform: 'linux', replace: true }).keyId).not.toBe(k.keyId);
    expect(() => setSecret('audit_signing_key', 'not a key', { dir, platform: 'linux' })).toThrow(/Ed25519 private key in PEM/);
  });

  it('the web service reads the key the way keygen stored it, and checks a file with the public key', () => {
    const dir = tmp();
    const k = generateAuditKey({ dir, platform: 'linux' });
    const viaFile = auditSigner(auditKeySourceFromEnv({ LIMS_AUDIT_SIGNING_KEY_FILE: join(dir, 'audit_signing_key') }));
    const viaCredential = auditSigner(auditKeySourceFromEnv({ CREDENTIALS_DIRECTORY: dir }));
    expect([viaFile?.keyId, viaCredential?.keyId]).toEqual([k.keyId, k.keyId]);
    expect(auditKeySourceFromEnv({})).toBeUndefined();
    expect(() => auditSigner(auditKeySourceFromEnv({ LIMS_AUDIT_SIGNING_KEY_FILE: join(dir, 'gone') }))).toThrow(/cannot be read/);

    const e = { id: '00000000-0000-7000-8000-000000000001', at: '2026-11-05T08:00:00.000Z', actor: 'dr', action: 'result.approve', entityType: 'result', entityId: 'r-1' };
    const line = auditExportLine({ seq: 1n, ...e, at: new Date(e.at), reason: null, correlationId: null, before: null, after: null, prevHash: AUDIT_GENESIS, hash: eventHash(AUDIT_GENESIS, e) });
    const exportFile = join(dir, 'audit.jsonl');
    writeFileSync(exportFile, line + auditExportTrailer([line], { exportedAt: new Date(), exportedBy: 'aud', filters: {} }, viaFile));
    const pubFile = join(dir, 'pub.pem');
    writeFileSync(pubFile, k.publicKeyPem);
    expect(verifyExportFile(exportFile, pubFile)).toMatchObject({ ok: true });
    writeFileSync(exportFile, readFileSync(exportFile, 'utf8').replace('"dr"', '"dx"'));
    expect(verifyExportFile(exportFile, pubFile).ok).toBe(false);
  });
});

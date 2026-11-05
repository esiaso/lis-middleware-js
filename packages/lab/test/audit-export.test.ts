import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AUDIT_GENESIS, auditExportLine, auditExportTrailer, auditSignerFromPem, eventHash, verifyAuditExport, type AuditExportRow } from '@lis/lab';

const pemKey = () => generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

/** A chain of n events as the database holds them. */
function chain(n: number): AuditExportRow[] {
  const rows: AuditExportRow[] = [];
  let prev = AUDIT_GENESIS;
  for (let i = 1; i <= n; i++) {
    const e = { id: `00000000-0000-7000-8000-${String(i).padStart(12, '0')}`, at: new Date(Date.UTC(2026, 10, 5, 8, 0, i)).toISOString(), actor: 'dr.lab', action: 'result.approve', entityType: 'result', entityId: `r-${i}`, after: { i, note: 'ü' } };
    const hash = eventHash(prev, e);
    rows.push({ seq: BigInt(i), id: e.id, at: new Date(e.at), actor: e.actor, action: e.action, entityType: e.entityType, entityId: e.entityId, reason: null, correlationId: null, before: null, after: e.after, prevHash: prev, hash });
    prev = hash;
  }
  return rows;
}
const meta = { exportedAt: new Date('2026-11-05T09:00:00Z'), exportedBy: 'aud', filters: {} };
const file = (rows: AuditExportRow[], pem?: string) => {
  const lines = rows.map(auditExportLine);
  return lines.join('') + auditExportTrailer(lines, meta, pem ? auditSignerFromPem(pem) : null);
};
const pubOf = (pem: string) => auditSignerFromPem(pem).publicKeyPem;

describe('audit export signing and checking', () => {
  it('a signed export checks out against its public key', () => {
    const pem = pemKey();
    const r = verifyAuditExport(file(chain(5), pem), { publicKeyPem: pubOf(pem) });
    expect(r.ok).toBe(true);
    expect(r.checks.map((c) => `${c.name}: ${c.status}`)).toEqual(['manifest: pass', 'events: pass', 'signature: pass']);
    expect(r.checks[1]!.detail).toBe('every event matches its hash; 4 links between consecutive events checked');
  });

  it('any change to an event, the manifest or the signature is caught', () => {
    const pem = pemKey();
    const good = file(chain(5), pem);
    const pub = { publicKeyPem: pubOf(pem) };
    // An edited event with a recomputed manifest hash still fails its own hash and the signature.
    expect(verifyAuditExport(good.replace('"r-3"', '"r-9"'), pub).checks.filter((c) => c.status === 'fail').map((c) => c.name)).toEqual(['manifest', 'events', 'signature']);
    expect(verifyAuditExport(good.replace('"exportedBy":"aud"', '"exportedBy":"someone"'), pub).checks.find((c) => c.name === 'signature')).toMatchObject({ status: 'fail' });
    expect(verifyAuditExport(good, { publicKeyPem: pubOf(pemKey()) }).checks.find((c) => c.name === 'signature')?.detail).toMatch(/but the public key given is/);
    const noSig = good.split('\n').slice(0, -2).join('\n') + '\n';
    expect(verifyAuditExport(noSig, pub).checks.find((c) => c.name === 'signature')).toMatchObject({ status: 'fail', detail: expect.stringMatching(/signature line is missing/) });
    expect(verifyAuditExport(good.slice(0, -5), pub).checks).toEqual([{ name: 'file', status: 'fail', detail: 'does not end with a complete line: it was cut short' }]);
  });

  it('an event removed from the middle of a contiguous export breaks the links', () => {
    const rows = chain(5);
    const r = verifyAuditExport(file([...rows.slice(0, 2), ...rows.slice(3)]));
    // seq 4 now follows seq 2: that is a gap, so the link is not checked, but its own hash still holds.
    expect(r.checks.find((c) => c.name === 'events')?.detail).toMatch(/1 gap where the filters left events out/);
    const forged = rows.map((x) => ({ ...x }));
    forged[3]!.seq = 3n; // renumbered to hide the gap
    forged[4]!.seq = 4n;
    expect(verifyAuditExport(file([...forged.slice(0, 2), ...forged.slice(3)])).checks.find((c) => c.name === 'events')).toMatchObject({ status: 'fail' });
  });

  it('an unsigned export passes with a warning, and a signed one without the key is only a warning', () => {
    expect(verifyAuditExport(file(chain(2))).checks.find((c) => c.name === 'signature')).toMatchObject({ status: 'warn', detail: expect.stringMatching(/not signed/) });
    const r = verifyAuditExport(file(chain(2), pemKey()));
    expect(r.ok).toBe(true);
    expect(r.checks.find((c) => c.name === 'signature')).toMatchObject({ status: 'warn', detail: expect.stringMatching(/give the public key/) });
  });

  it('only Ed25519 keys are taken', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(() => auditSignerFromPem(rsa)).toThrow(/must be Ed25519, not rsa/);
    expect(() => auditSignerFromPem('hello')).toThrow(/not a PEM private key/);
  });

  it('OpenSSL checks the same signature, as 11 §11 describes', () => {
    let version = '';
    try {
      version = execFileSync('openssl', ['version'], { encoding: 'utf8' });
    } catch {
      return; // no OpenSSL on this machine (the Windows runner); the Node check above covers the signature
    }
    if (!/^OpenSSL 3\./.test(version)) return;
    const pem = pemKey();
    const text = file(chain(3), pem);
    const lines = text.slice(0, -1).split('\n');
    const sig = JSON.parse(lines.pop()!) as { value: string };
    const dir = mkdtempSync(join(tmpdir(), 'audit-sig-'));
    try {
      writeFileSync(join(dir, 'body'), lines.map((l) => `${l}\n`).join(''));
      writeFileSync(join(dir, 'sig'), Buffer.from(sig.value, 'base64'));
      writeFileSync(join(dir, 'pub.pem'), pubOf(pem));
      const out = execFileSync('openssl', ['pkeyutl', '-verify', '-pubin', '-inkey', join(dir, 'pub.pem'), '-rawin', '-in', join(dir, 'body'), '-sigfile', join(dir, 'sig')], { encoding: 'utf8' });
      expect(out).toContain('Signature Verified Successfully');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

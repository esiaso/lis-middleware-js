import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { AUDIT_GENESIS, eventHash, type AuditInput } from './audit.js';

/**
 * The W-10 audit export (10 §8, 01 A-16): JSON lines, oldest first, then a
 * manifest line, then, when the lab has a signing key, a signature line.
 *
 * - Each event line carries its prevHash and hash, so anyone can recompute
 *   each event's hash and check that consecutive events link up.
 * - The manifest holds the count, the first and last sequence numbers and the
 *   SHA-256 of the event lines.
 * - The signature is Ed25519 over every byte before the signature line
 *   (events and manifest, as UTF-8). Only someone with the private key can
 *   make it; anyone with the public key can check it, with
 *   `lims audit verify-export` or with OpenSSL (11 §11).
 */
export const AUDIT_EXPORT_FORMAT = 'lims-audit-export/1';

export interface AuditSigner {
  /** First 16 hex characters of the SHA-256 of the public key (SubjectPublicKeyInfo, DER). */
  keyId: string;
  publicKeyPem: string;
  sign(data: Buffer): string;
}

export function auditKeyId(key: KeyObject): string {
  return createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);
}

/** From a PEM private key. Only Ed25519 is accepted. */
export function auditSignerFromPem(pem: string): AuditSigner {
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch {
    throw new Error('the audit signing key is not a PEM private key');
  }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(`the audit signing key must be Ed25519, not ${key.asymmetricKeyType ?? 'unknown'}`);
  const pub = createPublicKey(key);
  return {
    keyId: auditKeyId(pub),
    publicKeyPem: pub.export({ type: 'spki', format: 'pem' }).toString(),
    sign: (data) => sign(null, data, key).toString('base64'),
  };
}

export interface AuditExportRow {
  seq: bigint;
  id: string;
  at: Date;
  actor: string;
  action: string;
  entityType: string;
  entityId: string;
  reason: string | null;
  correlationId: string | null;
  before: unknown;
  after: unknown;
  prevHash: string;
  hash: string;
}

export function auditExportLine(r: AuditExportRow): string {
  return (
    JSON.stringify({
      seq: String(r.seq), id: r.id, at: r.at.toISOString(), actor: r.actor, action: r.action, entityType: r.entityType, entityId: r.entityId,
      reason: r.reason, correlationId: r.correlationId, before: r.before, after: r.after, prevHash: r.prevHash, hash: r.hash,
    }) + '\n'
  );
}

/** The manifest line and, with a signer, the signature line, for event lines already written. */
export function auditExportTrailer(eventLines: string[], meta: { exportedAt: Date; exportedBy: string; filters: unknown }, signer: AuditSigner | null): string {
  const hash = createHash('sha256');
  for (const l of eventLines) hash.update(l);
  const seqOf = (l: string | undefined) => (l ? (JSON.parse(l) as { seq: string }).seq : null);
  const manifest =
    JSON.stringify({
      type: 'manifest',
      format: AUDIT_EXPORT_FORMAT,
      exportedAt: meta.exportedAt.toISOString(),
      exportedBy: meta.exportedBy,
      filters: meta.filters,
      count: eventLines.length,
      firstSeq: seqOf(eventLines[0]),
      lastSeq: seqOf(eventLines[eventLines.length - 1]),
      sha256: hash.digest('hex'),
      signed: signer !== null,
      ...(signer ? { keyId: signer.keyId } : {}),
    }) + '\n';
  if (!signer) return manifest;
  const body = Buffer.concat([...eventLines.map((l) => Buffer.from(l, 'utf8')), Buffer.from(manifest, 'utf8')]);
  return manifest + JSON.stringify({ type: 'signature', alg: 'Ed25519', keyId: signer.keyId, value: signer.sign(body) }) + '\n';
}

export interface ExportCheck {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  detail: string;
}

/**
 * Check an export file on its own, away from the database: the manifest,
 * every event's hash, the links between consecutive events, and the
 * signature against the public key the hospital holds.
 */
export function verifyAuditExport(text: string, o: { publicKeyPem?: string } = {}): { ok: boolean; checks: ExportCheck[] } {
  const checks: ExportCheck[] = [];
  const add = (status: ExportCheck['status'], name: string, detail: string) => checks.push({ name, status, detail });
  const done = () => ({ ok: !checks.some((c) => c.status === 'fail'), checks });
  if (!text.endsWith('\n')) {
    add('fail', 'file', 'does not end with a complete line: it was cut short');
    return done();
  }
  const lines = text.slice(0, -1).split('\n').map((l) => `${l}\n`);
  const parsed: Record<string, unknown>[] = [];
  for (const [i, l] of lines.entries()) {
    try {
      parsed.push(JSON.parse(l) as Record<string, unknown>);
    } catch {
      add('fail', 'file', `line ${i + 1} is not JSON`);
      return done();
    }
  }
  let end = parsed.length;
  const sigLine = parsed[end - 1]?.['type'] === 'signature' ? parsed[--end] : undefined;
  const manifest = parsed[end - 1]?.['type'] === 'manifest' ? parsed[--end] : undefined;
  if (!manifest || manifest['format'] !== AUDIT_EXPORT_FORMAT) {
    add('fail', 'manifest', `no ${AUDIT_EXPORT_FORMAT} manifest line at the end`);
    return done();
  }
  const eventLines = lines.slice(0, end);
  const events = parsed.slice(0, end);
  const sha = createHash('sha256');
  for (const l of eventLines) sha.update(l);
  const digest = sha.digest('hex');
  if (manifest['count'] !== events.length) add('fail', 'manifest', `says ${String(manifest['count'])} events, the file has ${events.length}`);
  else if (manifest['sha256'] !== digest) add('fail', 'manifest', 'the SHA-256 of the events differs from the manifest: an event line was changed');
  else if ((events[0]?.['seq'] ?? null) !== manifest['firstSeq'] || (events[events.length - 1]?.['seq'] ?? null) !== manifest['lastSeq']) add('fail', 'manifest', 'the first or last sequence number differs from the manifest');
  else add('pass', 'manifest', `${events.length} events, seq ${String(manifest['firstSeq'] ?? '-')} to ${String(manifest['lastSeq'] ?? '-')}, exported ${String(manifest['exportedAt'])} by ${String(manifest['exportedBy'])}`);

  // Each event's own hash, and the link to the one before when the export holds both.
  let bad = 0;
  let firstBad = '';
  let links = 0;
  let gaps = 0;
  let prev: Record<string, unknown> | undefined;
  for (const e of events) {
    const input: AuditInput = { actor: String(e['actor']), action: String(e['action']), entityType: String(e['entityType']), entityId: String(e['entityId']) };
    if (e['reason'] !== null && e['reason'] !== undefined) input.reason = String(e['reason']);
    if (e['correlationId'] !== null && e['correlationId'] !== undefined) input.correlationId = String(e['correlationId']);
    if (e['before'] !== null && e['before'] !== undefined) input.before = e['before'];
    if (e['after'] !== null && e['after'] !== undefined) input.after = e['after'];
    const expected = eventHash(String(e['prevHash']), { ...input, id: String(e['id']), at: String(e['at']) });
    const consecutive = prev !== undefined && BigInt(String(e['seq'])) === BigInt(String(prev['seq'])) + 1n;
    const linkBroken = consecutive && e['prevHash'] !== prev!['hash'];
    const firstOfChain = String(e['seq']) === '1' && e['prevHash'] !== AUDIT_GENESIS;
    if (expected !== e['hash'] || linkBroken || firstOfChain) {
      bad++;
      firstBad ||= String(e['seq']);
    }
    if (consecutive) links++;
    else if (prev !== undefined) gaps++;
    prev = e;
  }
  if (bad) add('fail', 'events', `${bad} event${bad === 1 ? '' : 's'} do not match their hash or the one before, first at seq ${firstBad}`);
  else add('pass', 'events', `every event matches its hash; ${links} link${links === 1 ? '' : 's'} between consecutive events checked${gaps ? `, ${gaps} gap${gaps === 1 ? '' : 's'} where the filters left events out` : ''}`);

  if (!sigLine) {
    if (manifest['signed'] === true) add('fail', 'signature', 'the manifest says the export was signed, but the signature line is missing');
    else add('warn', 'signature', 'not signed: no audit signing key was set when it was exported');
    return done();
  }
  if (sigLine['alg'] !== 'Ed25519' || typeof sigLine['value'] !== 'string') {
    add('fail', 'signature', 'the signature line is not an Ed25519 signature');
    return done();
  }
  if (sigLine['keyId'] !== manifest['keyId']) add('fail', 'signature', 'the signature line and the manifest name different keys');
  if (!o.publicKeyPem) {
    add('warn', 'signature', `signed with key ${String(sigLine['keyId'])}; give the public key to check it`);
    return done();
  }
  let pub: KeyObject;
  try {
    pub = createPublicKey(o.publicKeyPem);
  } catch {
    add('fail', 'signature', 'the public key given is not a PEM public key');
    return done();
  }
  if (auditKeyId(pub) !== sigLine['keyId']) {
    add('fail', 'signature', `signed with key ${String(sigLine['keyId'])}, but the public key given is ${auditKeyId(pub)}`);
    return done();
  }
  const body = Buffer.from(lines.slice(0, end + 1).join(''), 'utf8');
  const good = verify(null, body, pub, Buffer.from(sigLine['value'], 'base64'));
  add(good ? 'pass' : 'fail', 'signature', good ? `valid, key ${auditKeyId(pub)}` : 'does not match: the file was changed after it was signed, or signed with another key');
  return done();
}

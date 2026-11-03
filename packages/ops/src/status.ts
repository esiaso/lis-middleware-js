import { connect } from 'node:net';
import type { Db } from '@lis/db';

/** `lims status`: who holds each analyzer link, and how far behind the queues are (11 §11). */
export async function statusReport(db: Db, now = new Date()): Promise<string> {
  const [instruments, inbox, outbox, unmatched] = await Promise.all([
    db.instrument.findMany({ orderBy: { id: 'asc' }, include: { lease: true } }),
    db.inboxMessage.groupBy({ by: ['status'], _count: { _all: true } }),
    db.outboxMessage.groupBy({ by: ['status'], _count: { _all: true } }),
    db.unmatchedResult.count({ where: { resolvedAt: null } }),
  ]);
  const counts = (rows: { status: string; _count: { _all: number } }[]) =>
    rows.length ? rows.map((r) => `${r.status.toLowerCase()} ${r._count._all}`).join(', ') : 'empty';
  const lines = ['Instruments:'];
  if (!instruments.length) lines.push('  (none registered)');
  for (const i of instruments) {
    const l = i.lease;
    const link = !l ? 'never connected' : l.leaseUntil > now ? `held by ${l.owner} (epoch ${l.epoch}) until ${l.leaseUntil.toISOString()}` : `lease expired ${l.leaseUntil.toISOString()} (last ${l.owner})`;
    lines.push(`  ${i.id.padEnd(16)} ${i.enabled ? 'on ' : 'off'}  ${i.verificationStatus.toLowerCase().padEnd(13)} ${link}`);
  }
  lines.push('', `Inbox:  ${counts(inbox)}`, `Outbox: ${counts(outbox)}`, `Unmatched results open: ${unmatched}`, '');
  return lines.join('\n');
}

/** `lims diag tcp <host> <port>`: can this server open a connection to a device server? Sends nothing. */
export function tcpProbe(host: string, port: number, timeoutMs = 5000): Promise<{ ok: boolean; detail: string }> {
  return new Promise((done) => {
    const started = Date.now();
    const s = connect({ host, port });
    const finish = (ok: boolean, detail: string) => {
      s.destroy();
      done({ ok, detail });
    };
    s.setTimeout(timeoutMs, () => finish(false, `no answer within ${timeoutMs} ms (firewall, wrong address, or device server off)`));
    s.once('connect', () => finish(true, `connected from ${s.localAddress}:${s.localPort} in ${Date.now() - started} ms; nothing was sent`));
    s.once('error', (e: NodeJS.ErrnoException) => finish(false, `${e.code ?? 'error'}: ${e.message}`));
  });
}

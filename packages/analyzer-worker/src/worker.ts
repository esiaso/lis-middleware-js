import { InstrumentConnectionConfig } from '@lis/contracts';
import { AstmSession, MllpSession, type LinkEvent } from '@lis/analyzer-runtime';
import { acquireLease, endLinkSession, isStaleLeaseError, PrismaRawMessageStore, releaseLease, renewLease, startLinkSession, uuidv7, type Db, type Lease } from '@lis/db';
import { createTransport, type Transport } from '@lis/transport';
import { linkProfile } from './profile.js';

export interface Logger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export type WorkerExit =
  | { reason: 'stopped' }
  | { reason: 'lease-held'; detail: string }
  | { reason: 'lease-lost' }
  | { reason: 'not-configured'; detail: string }
  | { reason: 'disabled' };

export interface WorkerOptions {
  db: Db;
  instrumentId: string;
  /** host:pid:bootId */
  owner: string;
  logger: Logger;
  signal: AbortSignal;
  leaseTtlSeconds?: number;
  renewEveryMs?: number;
  /** Tests inject a transport; production builds it from the stored config. */
  transportFactory?: (conn: InstrumentConnectionConfig) => Transport;
  /**
   * Run even if the instrument is disabled. Disabled instruments still need a
   * live link during interface verification, so this is the default; set false
   * to refuse.
   */
  allowDisabled?: boolean;
}

/**
 * One analyzer link, start to finish (03 §"Single owner per instrument"):
 * load config → take the lease (exit if someone else holds it) → open the
 * transport → store everything before ACK → renew the lease every 10 s and
 * stop at once if it is lost → on shutdown release the lease.
 *
 * Exits are returned, not thrown, so the caller sets the process exit code.
 */
export async function runWorker(o: WorkerOptions): Promise<WorkerExit> {
  const log = o.logger;
  const instrument = await o.db.instrument.findUnique({ where: { id: o.instrumentId } });
  if (!instrument) return { reason: 'not-configured', detail: `instrument ${o.instrumentId} is not registered` };
  if (!instrument.enabled && o.allowDisabled === false) return { reason: 'disabled' };

  const row = await o.db.instrumentConnection.findFirst({
    where: { instrumentId: o.instrumentId, activeFrom: { lte: new Date() }, OR: [{ activeTo: null }, { activeTo: { gt: new Date() } }] },
    orderBy: { activeFrom: 'desc' },
  });
  if (!row) return { reason: 'not-configured', detail: 'no active connection configuration' };
  const parsed = InstrumentConnectionConfig.safeParse(row.configJson);
  if (!parsed.success) {
    return { reason: 'not-configured', detail: `connection config invalid: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}` };
  }
  const conn = parsed.data;

  const lease = await acquireLease(o.db, o.instrumentId, o.owner, o.leaseTtlSeconds ?? 30);
  if (!lease) {
    const holder = await o.db.instrumentConnectionLease.findUnique({ where: { instrumentId: o.instrumentId } });
    return { reason: 'lease-held', detail: `held by ${holder?.owner ?? 'unknown'} until ${holder?.leaseUntil.toISOString() ?? '?'}` };
  }
  log.info({ instrumentId: o.instrumentId, epoch: String(lease.epoch), verification: instrument.verificationStatus }, 'lease acquired');
  if (instrument.verificationStatus !== 'LAB_ACCEPTED') {
    log.warn({ instrumentId: o.instrumentId, verification: instrument.verificationStatus }, 'instrument not lab-accepted: results will not be releasable');
  }

  const linkSessionId = await startLinkSession(o.db, lease);
  const store = new PrismaRawMessageStore(o.db, lease, linkSessionId);
  const transport = o.transportFactory ? o.transportFactory(conn) : createTransport(conn.transport);
  transport.on('state', (s, detail) => log.info({ state: s, detail }, 'transport state'));
  transport.on('error', (e) => log.warn({ err: e.message }, 'transport error'));
  transport.on('peer-rejected', (peer, why) => log.warn({ peer, why }, 'connection refused'));

  let lostLease = false;
  const onEvent = (e: LinkEvent) => {
    if (e.code === 'store-failed' && e.detail && isStaleLeaseError(new Error(e.detail))) lostLease = true;
    (e.level === 'warn' ? log.warn : log.info).call(log, { code: e.code, detail: e.detail }, 'link event');
  };

  const profile = linkProfile(conn);
  const session =
    profile.protocol === 'astm'
      ? new AstmSession({ transport, store, timings: profile.timings, splitMode: profile.splitMode, maxMessageBytes: conn.maxMessageBytes, onEvent })
      : new MllpSession({
          transport,
          store,
          maxMessageBytes: conn.maxMessageBytes,
          onEvent,
          onMessage: (_id, payload) => profile.buildReply(payload, uuidv7().replace(/-/g, '').slice(0, 20), new Date()),
        });

  await session.start();

  const exit = await new Promise<WorkerExit>((resolve) => {
    const renew = setInterval(() => {
      void renewLease(o.db, lease, o.leaseTtlSeconds ?? 30).then(
        (ok) => {
          if (!ok || lostLease) {
            clearInterval(renew);
            resolve({ reason: 'lease-lost' });
          }
        },
        (e: unknown) => {
          // Database unreachable: we cannot prove we still own the link, so stop (03 §1).
          log.error({ err: (e as Error).message }, 'lease renewal failed');
          clearInterval(renew);
          resolve({ reason: 'lease-lost' });
        },
      );
    }, o.renewEveryMs ?? 10_000);
    o.signal.addEventListener(
      'abort',
      () => {
        clearInterval(renew);
        resolve({ reason: 'stopped' });
      },
      { once: true },
    );
  });

  await session.stop(exit.reason);
  await endLinkSession(o.db, linkSessionId, exit.reason).catch((e: unknown) => log.warn({ err: (e as Error).message }, 'could not close link session'));
  if (exit.reason === 'stopped') await releaseLease(o.db, lease as Lease).catch(() => {});
  log.info({ instrumentId: o.instrumentId, reason: exit.reason }, 'worker stopped');
  return exit;
}

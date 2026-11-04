import type { Db } from '@lis/db';

/** Waiting longer than this in the outbox raises the dashboard warning. */
export const OUTBOX_LATE_MS = 15 * 60_000;
/** Polls failing this many times in a row raise the dashboard warning. */
export const POLL_FAILURES_WARN = 3;
/** No poll attempt at all for this long means the jobs worker is not polling (the longest poll interval is one hour). */
export const POLL_SILENT_MS = 2 * 60 * 60_000;

export interface HmisLinkStatus {
  /** Null when the jobs worker has never polled: no HMIS link is configured, or it has not started. */
  poll: {
    profile: string;
    lastAttemptAt: Date;
    lastSuccessAt: Date | null;
    lastReceived: number;
    failuresInARow: number;
    lastError: string | null;
    lastErrorAt: Date | null;
    cursorUpdatedAt: Date | null;
  } | null;
  outbox: {
    /** Released results not yet delivered: waiting for a first try, being sent, or waiting to try again. */
    waiting: number;
    /** Given up on: these need a person (the failed deliveries page). */
    dead: number;
    oldestWaitingAt: Date | null;
    lateCount: number;
  };
  /** What the dashboard should warn about; empty when the link looks healthy. */
  warnings: { kind: 'poll-failing' | 'poll-silent' | 'outbox-late'; text: string }[];
}

/** The HMIS link's health, read from what the jobs worker records (07 §6.6). */
export async function hmisLinkStatus(db: Db, now = new Date()): Promise<HmisLinkStatus> {
  const waitingWhere = { status: { in: ['PENDING', 'FAILED', 'IN_PROGRESS'] as ('PENDING' | 'FAILED' | 'IN_PROGRESS')[] } };
  const [poll, cursor, waiting, dead, oldest, late] = await Promise.all([
    db.hmisPollStatus.findUnique({ where: { name: 'orders' } }),
    db.hmisCursor.findUnique({ where: { name: 'orders' } }),
    db.outboxMessage.count({ where: waitingWhere }),
    db.outboxMessage.count({ where: { status: 'DEAD' } }),
    db.outboxMessage.findFirst({ where: waitingWhere, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
    db.outboxMessage.count({ where: { ...waitingWhere, createdAt: { lt: new Date(now.getTime() - OUTBOX_LATE_MS) } } }),
  ]);
  const warnings: HmisLinkStatus['warnings'] = [];
  if (poll && poll.failuresInARow >= POLL_FAILURES_WARN) {
    warnings.push({ kind: 'poll-failing', text: `the last ${poll.failuresInARow} order polls failed` });
  } else if (poll && now.getTime() - poll.lastAttemptAt.getTime() > POLL_SILENT_MS) {
    warnings.push({ kind: 'poll-silent', text: 'no order poll in the last two hours; is the jobs worker running?' });
  }
  if (late > 0) warnings.push({ kind: 'outbox-late', text: `${late} released result${late === 1 ? '' : 's'} not yet delivered after 15 minutes` });
  return {
    poll: poll
      ? {
          profile: poll.profile,
          lastAttemptAt: poll.lastAttemptAt,
          lastSuccessAt: poll.lastSuccessAt,
          lastReceived: poll.lastReceived,
          failuresInARow: poll.failuresInARow,
          lastError: poll.lastError,
          lastErrorAt: poll.lastErrorAt,
          cursorUpdatedAt: cursor?.updatedAt ?? null,
        }
      : null,
    outbox: { waiting, dead, oldestWaitingAt: oldest?.createdAt ?? null, lateCount: late },
    warnings,
  };
}

/** Released results still on their way, oldest first, and the latest delivery attempts. */
export async function hmisDeliveries(db: Db, take = 50) {
  const [waiting, attempts] = await Promise.all([
    db.outboxMessage.findMany({
      where: { status: { in: ['PENDING', 'FAILED', 'IN_PROGRESS'] } },
      orderBy: { createdAt: 'asc' },
      take,
      select: { id: true, resultId: true, idempotencyKey: true, topic: true, status: true, attempts: true, availableAt: true, lastError: true, createdAt: true },
    }),
    db.deliveryAttempt.findMany({ orderBy: { startedAt: 'desc' }, take: 20, include: { outbox: { select: { resultId: true, idempotencyKey: true } } } }),
  ]);
  return { waiting, attempts };
}

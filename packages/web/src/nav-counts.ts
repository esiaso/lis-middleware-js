import type { Db } from '@lis/db';
import { countWaitingCriticals, DOWNTIME } from '@lis/lab';
import type { NextFunction, Request, Response } from 'express';
import type { Logger } from 'pino';

/** Work waiting behind a menu link, by its href. Shown as a count beside the link. */
export type NavCounts = Partial<Record<string, number>>;

/** The same counts the dashboard shows, one query each. */
export async function navCounts(db: Db): Promise<NavCounts> {
  const [critical, unmatched, failedResults, failedOutbox, needsConfirmation, downtime] = await Promise.all([
    countWaitingCriticals(db),
    db.unmatchedResult.count({ where: { resolvedAt: null } }),
    db.result.count({ where: { status: 'failed' } }),
    db.outboxMessage.count({ where: { status: { in: ['FAILED', 'DEAD'] } } }),
    db.result.count({ where: { needsConfirmation: true } }),
    db.labOrder.count({ where: { source: DOWNTIME, reconciledAt: null, status: { not: 'cancelled' } } }),
  ]);
  return { '/critical': critical, '/unmatched': unmatched, '/failed': failedResults + failedOutbox + needsConfirmation, '/downtime': downtime };
}

/**
 * Puts the counts on res.locals for pages shown to a signed-in user. A count
 * that cannot be read is left out, and the page is shown without it.
 */
export function navCountsMiddleware(db: Db, logger: Logger) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const signedIn = !!(req as Request & { user?: unknown }).user;
    if (req.method !== 'GET' || !signedIn || req.path.startsWith('/static/') || req.path === '/health') return next();
    navCounts(db)
      .then((c) => { res.locals['navCounts'] = c; })
      .catch((err: unknown) => logger.warn({ err }, 'menu counts unavailable'))
      .finally(() => next());
  };
}

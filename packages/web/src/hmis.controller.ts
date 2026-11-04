import { Controller, Get, Inject, Req, Res } from '@nestjs/common';
import type { Db } from '@lis/db';
import { hmisDeliveries, hmisLinkStatus } from '@lis/lab';
import type { Response } from 'express';
import { page } from './controllers.js';
import { elapsed, formatTime } from './format.js';
import type { WebRequest } from './security.js';
import { DB } from './tokens.js';

const OUTBOX_STATUS: Record<string, string> = { PENDING: 'waiting for its first try', IN_PROGRESS: 'being sent', FAILED: 'will try again' };
const OUTCOME: Record<string, string> = {
  accepted: 'accepted',
  confirmed: 'confirmed by read-back',
  'not-found': 'not found by read-back; sent again',
  retryable: 'not delivered; will try again',
  ambiguous: 'no clear answer; will check before resending',
  rejected: 'refused by the HMIS',
};

/** The HMIS link's health: order polls and results on their way (07 §6.6). */
@Controller('hmis')
export class HmisController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  async status(@Req() req: WebRequest, @Res() res: Response): Promise<void> {
    const now = new Date();
    const [s, d] = await Promise.all([hmisLinkStatus(this.db, now), hmisDeliveries(this.db)]);
    const p = s.poll;
    page(req, res, 'hmis', {
      title: 'HMIS link',
      refresh: 60,
      warnings: s.warnings.map((w) => w.text),
      poll: p
        ? {
            profile: p.profile,
            lastAttempt: `${formatTime(p.lastAttemptAt)} (${elapsed(p.lastAttemptAt, now)} ago)`,
            lastSuccess: p.lastSuccessAt ? `${formatTime(p.lastSuccessAt)} (${elapsed(p.lastSuccessAt, now)} ago)` : 'never',
            ok: p.failuresInARow === 0,
            lastReceived: p.lastReceived,
            failures: p.failuresInARow,
            lastError: p.lastError,
            lastErrorAt: p.lastErrorAt ? formatTime(p.lastErrorAt) : '',
            cursorUpdated: p.cursorUpdatedAt ? formatTime(p.cursorUpdatedAt) : 'not yet',
          }
        : null,
      outbox: { ...s.outbox, oldest: s.outbox.oldestWaitingAt ? elapsed(s.outbox.oldestWaitingAt, now) : '' },
      waiting: d.waiting.map((m) => ({
        resultId: m.resultId,
        key: m.idempotencyKey,
        correction: m.topic === 'hmis.result.correct',
        status: OUTBOX_STATUS[m.status] ?? m.status,
        attempts: m.attempts,
        released: `${formatTime(m.createdAt)} (${elapsed(m.createdAt, now)} ago)`,
        next: m.status === 'FAILED' ? formatTime(m.availableAt) : '',
        error: m.lastError ?? '',
      })),
      attempts: d.attempts.map((a) => ({
        at: formatTime(a.startedAt),
        seconds: ((a.finishedAt.getTime() - a.startedAt.getTime()) / 1000).toFixed(1),
        resultId: a.outbox.resultId,
        key: a.outbox.idempotencyKey,
        outcome: OUTCOME[a.outcome] ?? a.outcome,
        good: a.outcome === 'accepted' || a.outcome === 'confirmed',
        detail: a.detail ?? '',
      })),
    });
  }
}

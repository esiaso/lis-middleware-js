import { Body, Controller, Get, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { Db } from '@lis/db';
import { criticalLabel, describeAge, parseCriticalLimit } from '@lis/domain';
import { addCriticalLimit, downtimeTestCatalogue, InvalidInput, recordCriticalCall, retireCriticalLimit, waitingCriticals } from '@lis/lab';
import type { Response } from 'express';
import { page, requireStepUp, str, uuidParam, type Form } from './controllers.js';
import { elapsed, formatTime } from './format.js';
import { Roles, type WebRequest } from './security.js';
import { DB } from './tokens.js';


const AGE_UNITS = ['days', 'months', 'years'];
const who = (c: { familyName: string | null; givenName: string | null; mrn: string }) => `${[c.familyName?.toUpperCase(), c.givenName].filter(Boolean).join(', ') || '(no name)'} (${c.mrn})`;

/** Critical results waiting for a call, and the limits that raise them (08 §12). */
@Controller('critical')
export class CriticalController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  async waiting(@Req() req: WebRequest, @Res() res: Response): Promise<void> {
    const now = new Date();
    const rows = await waitingCriticals(this.db);
    page(req, res, 'critical', {
      title: 'Critical results',
      refresh: 60,
      rows: rows.map((r) => ({
        href: `/results/${r.resultId}`,
        patient: who(r),
        location: r.location ?? '',
        test: r.test,
        version: r.versionNo,
        flag: criticalLabel(r.flag),
        detail: r.detail,
        accessionNo: r.accessionNo ?? '',
        arrived: formatTime(r.arrivedAt),
        waiting: elapsed(r.arrivedAt, now),
      })),
    });
  }

  @Get('limits')
  async limits(@Req() req: WebRequest, @Res() res: Response): Promise<void> {
    await this.renderLimits(req, res, {}, []);
  }

  private async renderLimits(req: WebRequest, res: Response, v: Record<string, string>, issues: string[], status = 200): Promise<void> {
    const [limits, retired, tests] = await Promise.all([
      this.db.criticalLimit.findMany({ where: { active: true }, orderBy: [{ localTestCode: 'asc' }, { createdAt: 'asc' }] }),
      this.db.criticalLimit.findMany({ where: { active: false }, orderBy: { retiredAt: 'desc' }, take: 50 }),
      downtimeTestCatalogue(this.db),
    ]);
    const row = (l: (typeof limits)[number]) => ({
      id: l.id,
      test: l.localTestCode,
      who: `${l.sex === 'F' ? 'female' : l.sex === 'M' ? 'male' : 'everyone'}, ${describeAge(l.ageMinDays, l.ageMaxDays)}`,
      low: l.low ?? '',
      high: l.high ?? '',
      units: l.units,
      reference: l.reference,
      by: l.createdBy,
      at: formatTime(l.createdAt),
      retiredBy: l.retiredBy ?? '',
      retiredAt: formatTime(l.retiredAt),
      retireReason: l.retireReason ?? '',
    });
    res.status(status);
    page(req, res, 'critical-limits', {
      title: 'Critical limits',
      limits: limits.map(row),
      retired: retired.map(row),
      tests: tests.map((code) => ({ code, selected: code === v['localTestCode'] })),
      v,
      minUnits: AGE_UNITS.map((unit) => ({ unit, selected: unit === (v['ageMinUnit'] || 'years') })),
      maxUnits: AGE_UNITS.map((unit) => ({ unit, selected: unit === (v['ageMaxUnit'] || 'years') })),
      issues,
    });
  }

  /** The lab director (approver role) sets limits; the values come from the lab's own policy, never from here. */
  @Post('limits')
  @Roles('approver')
  async add(@Req() req: WebRequest, @Res() res: Response, @Body() body: Form): Promise<void> {
    const keys = ['localTestCode', 'sex', 'ageMin', 'ageMinUnit', 'ageMax', 'ageMaxUnit', 'low', 'high', 'units', 'reference'] as const;
    const v = Object.fromEntries(keys.map((k) => [k, str(body, k)])) as Record<(typeof keys)[number], string>;
    // Check the values before asking for confirmation, so a typo does not use up a hospital sign-in step-up.
    const parsed = parseCriticalLimit(v);
    if (!parsed.ok) return this.renderLimits(req, res, v, parsed.issues, 422);
    await requireStepUp(this.db, req, str(body, 'password'));
    try {
      await addCriticalLimit(this.db, req.user!.username, v);
    } catch (e) {
      if (e instanceof InvalidInput) return this.renderLimits(req, res, v, e.issues, 422);
      throw e;
    }
    res.redirect(303, '/critical/limits?notice=limit-added');
  }

  @Post('limits/:id/retire')
  @Roles('approver')
  async retire(@Req() req: WebRequest, @Res() res: Response, @Param('id') id: string, @Body() body: Form): Promise<void> {
    await requireStepUp(this.db, req, str(body, 'password'));
    await retireCriticalLimit(this.db, req.user!.username, uuidParam(id), str(body, 'reason'));
    res.redirect(303, '/critical/limits?notice=limit-retired');
  }
}

/** Recording the call lives under the result it belongs to. */
@Controller('results')
export class CriticalCallController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Post(':id/critical-call')
  @Roles('technologist', 'approver')
  async call(@Req() req: WebRequest, @Res() res: Response, @Param('id') id: string, @Body() body: Form): Promise<void> {
    const minutes = str(body, 'minutesAgo').trim() || '0';
    const calledAt = /^\d{1,4}$/.test(minutes) && Number(minutes) <= 24 * 60 ? new Date(Date.now() - Number(minutes) * 60_000) : null;
    await recordCriticalCall(this.db, uuidParam(id), req.user!.username, {
      versionNo: Number(str(body, 'versionNo')),
      notified: str(body, 'notified'),
      notifiedRole: str(body, 'notifiedRole'),
      calledAt,
      readBack: str(body, 'readBack') === 'yes',
      note: str(body, 'note'),
    });
    res.redirect(303, `/results/${id}?notice=critical-called`);
  }
}

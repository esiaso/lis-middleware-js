import { Body, Controller, Get, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { Db } from '@lis/db';
import { describeReferenceWho, parseReferenceRange } from '@lis/domain';
import { addReferenceRange, downtimeTestCatalogue, InvalidInput, retireReferenceRange } from '@lis/lab';
import type { Response } from 'express';
import { page, requireStepUp, str, uuidParam, type Form } from './controllers.js';
import { formatTime } from './format.js';
import { Roles, type WebRequest } from './security.js';
import { DB } from './tokens.js';

const AGE_UNITS = ['days', 'months', 'years'];

/** Reference ranges entered by the lab (01 A-25). */
@Controller('reference-ranges')
export class ReferenceRangesController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  async list(@Req() req: WebRequest, @Res() res: Response): Promise<void> {
    await this.render(req, res, {}, []);
  }

  private async render(req: WebRequest, res: Response, v: Record<string, string>, issues: string[], status = 200): Promise<void> {
    const [ranges, retired, tests] = await Promise.all([
      this.db.referenceRange.findMany({ where: { active: true }, orderBy: [{ localTestCode: 'asc' }, { sex: 'asc' }, { ageMinDays: 'asc' }] }),
      this.db.referenceRange.findMany({ where: { active: false }, orderBy: { retiredAt: 'desc' }, take: 50 }),
      downtimeTestCatalogue(this.db),
    ]);
    const row = (r: (typeof ranges)[number]) => ({
      id: r.id,
      test: r.localTestCode,
      who: describeReferenceWho(r),
      low: r.low ?? '',
      high: r.high ?? '',
      units: r.units,
      reference: r.reference,
      by: r.createdBy,
      at: formatTime(r.createdAt),
      retiredBy: r.retiredBy ?? '',
      retiredAt: formatTime(r.retiredAt),
      retireReason: r.retireReason ?? '',
    });
    res.status(status);
    page(req, res, 'reference-ranges', {
      title: 'Reference ranges',
      ranges: ranges.map(row),
      retired: retired.map(row),
      tests: tests.map((code) => ({ code, selected: code === v['localTestCode'] })),
      v,
      minUnits: AGE_UNITS.map((unit) => ({ unit, selected: unit === (v['ageMinUnit'] || 'years') })),
      maxUnits: AGE_UNITS.map((unit) => ({ unit, selected: unit === (v['ageMaxUnit'] || 'years') })),
      issues,
    });
  }

  @Post()
  @Roles('approver')
  async add(@Req() req: WebRequest, @Res() res: Response, @Body() body: Form): Promise<void> {
    const keys = ['localTestCode', 'sex', 'ageMin', 'ageMinUnit', 'ageMax', 'ageMaxUnit', 'low', 'high', 'units', 'reference'] as const;
    const v = Object.fromEntries(keys.map((k) => [k, str(body, k)])) as Record<(typeof keys)[number], string>;
    const parsed = parseReferenceRange(v);
    if (!parsed.ok) return this.render(req, res, v, parsed.issues, 422);
    await requireStepUp(this.db, req, str(body, 'password'));
    try {
      await addReferenceRange(this.db, req.user!.username, v);
    } catch (e) {
      if (e instanceof InvalidInput) return this.render(req, res, v, e.issues, 422);
      throw e;
    }
    res.redirect(303, '/reference-ranges?notice=reference-range-added');
  }

  @Post(':id/retire')
  @Roles('approver')
  async retire(@Req() req: WebRequest, @Res() res: Response, @Param('id') id: string, @Body() body: Form): Promise<void> {
    await requireStepUp(this.db, req, str(body, 'password'));
    await retireReferenceRange(this.db, req.user!.username, uuidParam(id), str(body, 'reason'));
    res.redirect(303, '/reference-ranges?notice=reference-range-retired');
  }
}

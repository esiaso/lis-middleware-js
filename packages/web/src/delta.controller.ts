import { Body, Controller, Get, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { Db } from '@lis/db';
import { parseDeltaRule } from '@lis/domain';
import { addDeltaRule, downtimeTestCatalogue, InvalidInput, retireDeltaRule } from '@lis/lab';
import type { Response } from 'express';
import { page, requireStepUp, str, uuidParam, type Form } from './controllers.js';
import { formatTime } from './format.js';
import { Roles, type WebRequest } from './security.js';
import { DB } from './tokens.js';

/** Delta check rules (08 §12, A-20). None until the lab adds them. */
@Controller('delta-checks')
export class DeltaController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  async list(@Req() req: WebRequest, @Res() res: Response): Promise<void> {
    await this.render(req, res, {}, []);
  }

  private async render(req: WebRequest, res: Response, v: Record<string, string>, issues: string[], status = 200): Promise<void> {
    const [rules, retired, tests] = await Promise.all([
      this.db.deltaRule.findMany({ where: { active: true }, orderBy: { localTestCode: 'asc' } }),
      this.db.deltaRule.findMany({ where: { active: false }, orderBy: { retiredAt: 'desc' }, take: 50 }),
      downtimeTestCatalogue(this.db),
    ]);
    const row = (r: (typeof rules)[number]) => ({
      id: r.id,
      test: r.localTestCode,
      limit: [r.maxAbs ? `${r.maxAbs} ${r.units}` : '', r.maxPercent ? `${r.maxPercent}%` : ''].filter(Boolean).join(' or '),
      units: r.units,
      window: `${r.windowDays} day${r.windowDays === 1 ? '' : 's'}`,
      reference: r.reference,
      by: r.createdBy,
      at: formatTime(r.createdAt),
      retiredBy: r.retiredBy ?? '',
      retiredAt: formatTime(r.retiredAt),
      retireReason: r.retireReason ?? '',
    });
    res.status(status);
    page(req, res, 'delta-checks', {
      title: 'Delta checks',
      rules: rules.map(row),
      retired: retired.map(row),
      tests: tests.map((code) => ({ code, selected: code === v['localTestCode'] })),
      v,
      issues,
    });
  }

  @Post()
  @Roles('approver')
  async add(@Req() req: WebRequest, @Res() res: Response, @Body() body: Form): Promise<void> {
    const v = { localTestCode: str(body, 'localTestCode'), maxAbs: str(body, 'maxAbs'), maxPercent: str(body, 'maxPercent'), windowDays: str(body, 'windowDays'), units: str(body, 'units'), reference: str(body, 'reference') };
    const parsed = parseDeltaRule(v);
    if (!parsed.ok) return this.render(req, res, v, parsed.issues, 422);
    await requireStepUp(this.db, req, str(body, 'password'));
    try {
      await addDeltaRule(this.db, req.user!.username, v);
    } catch (e) {
      if (e instanceof InvalidInput) return this.render(req, res, v, e.issues, 422);
      throw e;
    }
    res.redirect(303, '/delta-checks?notice=delta-added');
  }

  @Post(':id/retire')
  @Roles('approver')
  async retire(@Req() req: WebRequest, @Res() res: Response, @Param('id') id: string, @Body() body: Form): Promise<void> {
    await requireStepUp(this.db, req, str(body, 'password'));
    await retireDeltaRule(this.db, req.user!.username, uuidParam(id), str(body, 'reason'));
    res.redirect(303, '/delta-checks?notice=delta-retired');
  }
}

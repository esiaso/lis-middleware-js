import { Body, Controller, Get, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { Db } from '@lis/db';
import { parseAutoverifyRule } from '@lis/domain';
import { addAutoverifyRule, downtimeTestCatalogue, InvalidInput, retireAutoverifyRule } from '@lis/lab';
import type { Response } from 'express';
import { page, requireStepUp, str, uuidParam, type Form } from './controllers.js';
import { formatTime } from './format.js';
import { Roles, type WebRequest } from './security.js';
import { DB } from './tokens.js';

/** Autoverification rules (08 §12, A-19). Off for every test until the lab director adds a rule. */
@Controller('autoverification')
export class AutoverificationController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  async list(@Req() req: WebRequest, @Res() res: Response): Promise<void> {
    await this.render(req, res, {}, []);
  }

  private async render(req: WebRequest, res: Response, v: Record<string, string>, issues: string[], status = 200): Promise<void> {
    const since = new Date(Date.now() - 7 * 24 * 3600_000);
    const [rules, retired, tests, counts] = await Promise.all([
      this.db.autoverifyRule.findMany({ where: { active: true }, orderBy: { localTestCode: 'asc' } }),
      this.db.autoverifyRule.findMany({ where: { active: false }, orderBy: { retiredAt: 'desc' }, take: 50 }),
      downtimeTestCatalogue(this.db),
      this.db.autoverificationDecision.groupBy({ by: ['ruleId', 'passed'], where: { at: { gte: since } }, _count: { _all: true } }),
    ]);
    const n = (ruleId: string, passed: boolean) => counts.find((c) => c.ruleId === ruleId && c.passed === passed)?._count._all ?? 0;
    const row = (r: (typeof rules)[number]) => ({
      id: r.id,
      test: r.localTestCode,
      low: r.low,
      high: r.high,
      units: r.units,
      reference: r.reference,
      by: r.createdBy,
      at: formatTime(r.createdAt),
      passed: n(r.id, true),
      held: n(r.id, false),
      retiredBy: r.retiredBy ?? '',
      retiredAt: formatTime(r.retiredAt),
      retireReason: r.retireReason ?? '',
    });
    res.status(status);
    page(req, res, 'autoverification', {
      title: 'Autoverification',
      rules: rules.map(row),
      retired: retired.map(row),
      tests: tests.map((code) => ({ code, selected: code === v['localTestCode'] })),
      v,
      issues,
    });
  }

  /** The lab director (approver role) turns a test on, naming the validation report behind it. */
  @Post()
  @Roles('approver')
  async add(@Req() req: WebRequest, @Res() res: Response, @Body() body: Form): Promise<void> {
    const v = { localTestCode: str(body, 'localTestCode'), low: str(body, 'low'), high: str(body, 'high'), units: str(body, 'units'), reference: str(body, 'reference'), qc: str(body, 'qc') };
    const input = { ...v, qcAcknowledged: v.qc === 'yes' };
    // Values first, so a typo does not use up a step-up.
    const parsed = parseAutoverifyRule(input);
    if (!parsed.ok) return this.render(req, res, v, parsed.issues, 422);
    await requireStepUp(this.db, req, str(body, 'password'));
    try {
      await addAutoverifyRule(this.db, req.user!.username, input);
    } catch (e) {
      if (e instanceof InvalidInput) return this.render(req, res, v, e.issues, 422);
      throw e;
    }
    res.redirect(303, '/autoverification?notice=autoverify-added');
  }

  @Post(':id/retire')
  @Roles('approver')
  async retire(@Req() req: WebRequest, @Res() res: Response, @Param('id') id: string, @Body() body: Form): Promise<void> {
    await requireStepUp(this.db, req, str(body, 'password'));
    await retireAutoverifyRule(this.db, req.user!.username, uuidParam(id), str(body, 'reason'));
    res.redirect(303, '/autoverification?notice=autoverify-retired');
  }
}

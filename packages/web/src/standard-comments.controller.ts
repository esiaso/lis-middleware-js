import { Body, Controller, Get, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { Db } from '@lis/db';
import { addStandardComment, downtimeTestCatalogue, InvalidInput, parseStandardComment, retireStandardComment } from '@lis/lab';
import type { Response } from 'express';
import { page, requireStepUp, str, uuidParam, type Form } from './controllers.js';
import { formatTime } from './format.js';
import { Roles, type WebRequest } from './security.js';
import { DB } from './tokens.js';

/** Standard comments the lab keeps ready to pick on a result (01 A-27). */
@Controller('standard-comments')
export class StandardCommentsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  async list(@Req() req: WebRequest, @Res() res: Response): Promise<void> {
    await this.render(req, res, {}, []);
  }

  private async render(req: WebRequest, res: Response, v: Record<string, string>, issues: string[], status = 200): Promise<void> {
    const [active, retired, tests] = await Promise.all([
      this.db.standardComment.findMany({ where: { active: true }, orderBy: { code: 'asc' } }),
      this.db.standardComment.findMany({ where: { active: false }, orderBy: { retiredAt: 'desc' }, take: 50 }),
      downtimeTestCatalogue(this.db),
    ]);
    const row = (c: (typeof active)[number]) => ({
      id: c.id,
      code: c.code,
      text: c.text,
      test: c.localTestCode ?? '',
      by: c.createdBy,
      at: formatTime(c.createdAt),
      retiredBy: c.retiredBy ?? '',
      retiredAt: formatTime(c.retiredAt),
      retireReason: c.retireReason ?? '',
    });
    res.status(status);
    page(req, res, 'standard-comments', {
      title: 'Standard comments',
      comments: active.map(row),
      retired: retired.map(row),
      tests: tests.map((code) => ({ code, selected: code === v['localTestCode'] })),
      v,
      issues,
    });
  }

  @Post()
  @Roles('approver')
  async add(@Req() req: WebRequest, @Res() res: Response, @Body() body: Form): Promise<void> {
    const v = { code: str(body, 'code'), text: str(body, 'text'), localTestCode: str(body, 'localTestCode') };
    const parsed = parseStandardComment(v);
    if (!parsed.ok) return this.render(req, res, v, parsed.issues, 422);
    await requireStepUp(this.db, req, str(body, 'password'));
    try {
      await addStandardComment(this.db, req.user!.username, v);
    } catch (e) {
      if (e instanceof InvalidInput) return this.render(req, res, v, e.issues, 422);
      throw e;
    }
    res.redirect(303, '/standard-comments?notice=standard-comment-added');
  }

  @Post(':id/retire')
  @Roles('approver')
  async retire(@Req() req: WebRequest, @Res() res: Response, @Param('id') id: string, @Body() body: Form): Promise<void> {
    await requireStepUp(this.db, req, str(body, 'password'));
    await retireStandardComment(this.db, req.user!.username, uuidParam(id), str(body, 'reason'));
    res.redirect(303, '/standard-comments?notice=standard-comment-retired');
  }
}

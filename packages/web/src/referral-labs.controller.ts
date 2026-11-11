import { Body, Controller, Get, Inject, NotFoundException, Param, Post, Req, Res } from '@nestjs/common';
import type { Db } from '@lis/db';
import { activeCatalogue, addReferralTest, createReferralLab, InvalidInput, retireReferralTest, updateReferralLab, type ReferralLabInput } from '@lis/lab';
import type { Response } from 'express';
import { page, str, uuidParam, type Form } from './controllers.js';
import { formatTime } from './format.js';
import { Roles, type WebRequest } from './security.js';
import { DB } from './tokens.js';

const FIELDS: (keyof ReferralLabInput)[] = ['code', 'name', 'address', 'phone', 'email', 'notes'];
const formOf = (body: Form) => Object.fromEntries(FIELDS.map((k) => [k, str(body, k)])) as unknown as ReferralLabInput;
const hours = (h: number) => (h % 24 === 0 ? `${h / 24} day${h === 24 ? '' : 's'}` : `${h} h`);

/** Referral labs and the tests each does for the lab, with the agreed turnaround (01 A-43, 09 W-27). */
@Controller('referral-labs')
export class ReferralLabsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  async list(@Req() req: WebRequest, @Res() res: Response): Promise<void> {
    await this.renderList(req, res, null, []);
  }

  private async renderList(req: WebRequest, res: Response, v: ReferralLabInput | null, issues: string[], status = 200): Promise<void> {
    const labs = await this.db.referralLab.findMany({ orderBy: [{ active: 'desc' }, { code: 'asc' }], include: { tests: { where: { active: true } }, sendOuts: { where: { status: { in: ['sent', 'received'] } }, select: { id: true } } } });
    res.status(status);
    page(req, res, 'referral-labs', {
      title: 'Referral labs',
      labs: labs.map((l) => ({ id: l.id, code: l.code, name: l.name, phone: l.phone ?? '', email: l.email ?? '', active: l.active, tests: l.tests.map((t) => t.localTestCode).sort().join(' '), open: l.sendOuts.length })),
      v: v ?? {},
      issues,
      canEdit: canEdit(req),
    });
  }

  @Post()
  @Roles('admin', 'approver')
  async create(@Req() req: WebRequest, @Res() res: Response, @Body() body: Form): Promise<void> {
    const v = formOf(body);
    try {
      const id = await createReferralLab(this.db, req.user!.username, v);
      res.redirect(303, `/referral-labs/${id}?notice=referral-lab-saved`);
    } catch (e) {
      if (e instanceof InvalidInput) return this.renderList(req, res, v, e.issues, 422);
      throw e;
    }
  }

  @Get(':id')
  async show(@Req() req: WebRequest, @Res() res: Response, @Param('id') id: string): Promise<void> {
    await this.renderLab(req, res, uuidParam(id), {});
  }

  private async renderLab(req: WebRequest, res: Response, id: string, failed: { lab?: ReferralLabInput; labIssues?: string[]; test?: Record<string, string>; testIssues?: string[] }, status = 200): Promise<void> {
    const lab = await this.db.referralLab.findUnique({ where: { id }, include: { tests: { orderBy: [{ active: 'desc' }, { localTestCode: 'asc' }] } } });
    if (!lab) throw new NotFoundException();
    const catalogue = await activeCatalogue(this.db);
    const names = new Map(catalogue.map((e) => [e.localCode, e.name]));
    const has = new Set(lab.tests.filter((t) => t.active).map((t) => t.localTestCode));
    const t = failed.test ?? {};
    res.status(status);
    page(req, res, 'referral-lab', {
      title: `${lab.code}: ${lab.name}`,
      lab: { id: lab.id, code: lab.code, name: lab.name, active: lab.active },
      v: failed.lab ?? { code: lab.code, name: lab.name, address: lab.address ?? '', phone: lab.phone ?? '', email: lab.email ?? '', notes: lab.notes ?? '' },
      labIssues: failed.labIssues ?? [],
      tests: lab.tests.filter((x) => x.active).map((x) => ({ id: x.id, code: x.localTestCode, name: names.get(x.localTestCode) ?? '', tat: hours(x.tatHours), tatHours: x.tatHours, note: x.specimenNote ?? '', by: x.createdBy, at: formatTime(x.createdAt) })),
      retired: lab.tests.filter((x) => !x.active).map((x) => ({ code: x.localTestCode, tat: hours(x.tatHours), by: x.retiredBy ?? '', at: formatTime(x.retiredAt) })),
      catalogue: catalogue.filter((e) => e.resultType !== 'PANEL' && !has.has(e.localCode)).map((e) => ({ code: e.localCode, name: e.name, selected: e.localCode === t['localTestCode'] })),
      t,
      testIssues: failed.testIssues ?? [],
      canEdit: canEdit(req),
    });
  }

  @Post(':id')
  @Roles('admin', 'approver')
  async update(@Req() req: WebRequest, @Res() res: Response, @Param('id') id: string, @Body() body: Form): Promise<void> {
    const lid = uuidParam(id);
    const v = formOf(body);
    try {
      await updateReferralLab(this.db, req.user!.username, lid, v, str(body, 'active') === '1');
    } catch (e) {
      if (e instanceof InvalidInput) return this.renderLab(req, res, lid, { lab: v, labIssues: e.issues }, 422);
      throw e;
    }
    res.redirect(303, `/referral-labs/${lid}?notice=referral-lab-saved`);
  }

  @Post(':id/tests')
  @Roles('admin', 'approver')
  async addTest(@Req() req: WebRequest, @Res() res: Response, @Param('id') id: string, @Body() body: Form): Promise<void> {
    const lid = uuidParam(id);
    const t = { localTestCode: str(body, 'localTestCode'), tatHours: str(body, 'tatHours'), specimenNote: str(body, 'specimenNote') };
    try {
      await addReferralTest(this.db, req.user!.username, lid, t);
    } catch (e) {
      if (e instanceof InvalidInput) return this.renderLab(req, res, lid, { test: t, testIssues: e.issues }, 422);
      throw e;
    }
    res.redirect(303, `/referral-labs/${lid}?notice=referral-test-added`);
  }

  @Post(':id/tests/:testId/retire')
  @Roles('admin', 'approver')
  async retire(@Req() req: WebRequest, @Res() res: Response, @Param('id') id: string, @Param('testId') testId: string): Promise<void> {
    uuidParam(id);
    const labId = await retireReferralTest(this.db, req.user!.username, uuidParam(testId));
    res.redirect(303, `/referral-labs/${labId}?notice=referral-test-retired`);
  }
}

function canEdit(req: WebRequest): boolean {
  const r = req.user?.roles ?? [];
  return r.includes('admin') || r.includes('approver');
}

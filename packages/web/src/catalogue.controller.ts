import { Body, Controller, Get, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Db } from '@lis/db';
import { answersText, type CatalogueForm } from '@lis/domain';
import {
  activeCatalogue, activeEntry, approveCatalogueEntry, catalogueDrafts, discardCatalogueDraft, enterManualResult, InvalidInput, manualWorksheet,
  proposeCatalogueEntry, retireCatalogueEntry, type CatalogueEntry,
} from '@lis/lab';
import type { Response } from 'express';
import { page, requireStepUp, str, uuidParam, type Form } from './controllers.js';
import { formatTime } from './format.js';
import { Roles, type WebRequest } from './security.js';
import { DB } from './tokens.js';

const FIELDS = ['localCode', 'name', 'section', 'loincCode', 'loincDisplay', 'shaCode', 'specimenType', 'performedBy', 'resultType', 'answers', 'unit', 'decimals'] as const;
const TYPE_WORDS: Record<string, string> = { NUMERIC: 'Number', ORDINAL: 'Ordered choice', NOMINAL: 'Choice', TEXT: 'Text' };

const formFrom = (body: Form): CatalogueForm => Object.fromEntries(FIELDS.map((k) => [k, str(body, k)])) as unknown as CatalogueForm;
const formOf = (e: CatalogueEntry): CatalogueForm => ({
  localCode: e.localCode,
  name: e.name,
  section: e.section,
  loincCode: e.loincCode ?? '',
  loincDisplay: e.loincDisplay ?? '',
  shaCode: e.shaCode ?? '',
  specimenType: e.specimenType ?? '',
  performedBy: e.performedBy,
  resultType: e.resultType,
  answers: answersText(e.answers),
  unit: e.unit ?? '',
  decimals: e.decimals === undefined ? '' : String(e.decimals),
});

const view = (e: CatalogueEntry) => ({
  id: e.id,
  localCode: e.localCode,
  versionNo: e.versionNo,
  name: e.name,
  section: e.section,
  loinc: e.loincCode ?? '',
  loincDisplay: e.loincDisplay ?? '',
  sha: e.shaCode ?? '',
  specimenType: e.specimenType ?? '',
  manual: e.performedBy === 'MANUAL',
  type: TYPE_WORDS[e.resultType] ?? e.resultType,
  answers: e.answers.map((a) => ({ ...a })),
  unit: e.unit ?? '',
  decimals: e.decimals ?? '',
  reason: e.changeReason,
  by: e.createdBy,
  at: formatTime(e.createdAt),
  approvedBy: e.approvedBy ?? '',
  approvedAt: formatTime(e.approvedAt ?? null),
});

/** The lab's test catalogue with LOINC codes (design: "Test catalogue and LOINC"). */
@Controller('catalogue')
export class CatalogueController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  async list(@Req() req: WebRequest, @Res() res: Response, @Query('edit') edit?: string): Promise<void> {
    const current = typeof edit === 'string' && edit ? await activeEntry(this.db, edit) : null;
    await this.render(req, res, current ? formOf(current) : undefined, [], undefined);
  }

  private async render(req: WebRequest, res: Response, f: CatalogueForm | undefined, issues: string[], reason: string | undefined, status = 200): Promise<void> {
    const [active, drafts] = await Promise.all([activeCatalogue(this.db), catalogueDrafts(this.db)]);
    const v = f ?? { localCode: '', name: '', section: '', loincCode: '', loincDisplay: '', shaCode: '', specimenType: '', performedBy: 'MANUAL', resultType: 'NUMERIC', answers: '', unit: '', decimals: '' };
    const roles = req.user?.roles ?? [];
    res.status(status);
    page(req, res, 'catalogue', {
      title: 'Test catalogue',
      tests: active.map(view),
      drafts: drafts.map((d) => ({ ...view(d), mine: d.createdBy === req.user?.username })),
      canEdit: roles.includes('admin') || roles.includes('approver'),
      v,
      reason: reason ?? '',
      editing: Boolean(f?.localCode && active.some((e) => e.localCode === f.localCode)),
      performed: [
        { value: 'MANUAL', label: 'A person (worksheet)', selected: v.performedBy === 'MANUAL' },
        { value: 'INSTRUMENT', label: 'An instrument', selected: v.performedBy === 'INSTRUMENT' },
      ],
      types: Object.entries(TYPE_WORDS).map(([value, label]) => ({ value, label, selected: v.resultType === value })),
      issues,
    });
  }

  @Post()
  @Roles('admin', 'approver')
  async propose(@Req() req: WebRequest, @Res() res: Response, @Body() body: Form): Promise<void> {
    const f = formFrom(body);
    try {
      await proposeCatalogueEntry(this.db, req.user!.username, f, str(body, 'reason'));
    } catch (e) {
      if (e instanceof InvalidInput) return this.render(req, res, f, e.issues, str(body, 'reason'), 422);
      throw e;
    }
    res.redirect(303, '/catalogue?notice=catalogue-proposed');
  }

  @Post(':id/approve')
  @Roles('admin', 'approver')
  async approve(@Req() req: WebRequest, @Res() res: Response, @Param('id') id: string, @Body() body: Form): Promise<void> {
    await requireStepUp(this.db, req, str(body, 'password'));
    await approveCatalogueEntry(this.db, req.user!.username, uuidParam(id));
    res.redirect(303, '/catalogue?notice=catalogue-approved');
  }

  @Post(':id/discard')
  @Roles('admin', 'approver')
  async discard(@Req() req: WebRequest, @Res() res: Response, @Param('id') id: string, @Body() body: Form): Promise<void> {
    await discardCatalogueDraft(this.db, req.user!.username, uuidParam(id), str(body, 'reason'));
    res.redirect(303, '/catalogue?notice=catalogue-discarded');
  }

  @Post('retire')
  @Roles('admin', 'approver')
  async retire(@Req() req: WebRequest, @Res() res: Response, @Body() body: Form): Promise<void> {
    await requireStepUp(this.db, req, str(body, 'password'));
    await retireCatalogueEntry(this.db, req.user!.username, str(body, 'localCode'), str(body, 'reason'));
    res.redirect(303, '/catalogue?notice=catalogue-retired');
  }
}

/** The bench worksheet for tests read by a person (design: "Manual tests"). */
@Controller('worksheet')
export class WorksheetController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  async list(@Req() req: WebRequest, @Res() res: Response, @Query('section') section?: string): Promise<void> {
    await this.render(req, res, typeof section === 'string' ? section : '', {}, 200);
  }

  private async render(req: WebRequest, res: Response, section: string, failed: { id?: string; issues?: string[]; value?: string; performedBy?: string; lot?: string }, status: number): Promise<void> {
    const [all, rows] = await Promise.all([activeCatalogue(this.db), manualWorksheet(this.db, section ? { section } : {})]);
    const sections = [...new Set(all.filter((e) => e.performedBy === 'MANUAL').map((e) => e.section))].sort();
    res.status(status);
    page(req, res, 'worksheet', {
      title: 'Manual worksheet',
      sections: sections.map((s) => ({ name: s, selected: s === section })),
      section,
      anyManual: sections.length > 0,
      rows: rows.map((r) => {
        const mine = failed.id === r.orderedTestId;
        return {
          id: r.orderedTestId,
          accessionNo: r.accessionNo,
          priority: r.priority,
          stat: r.priority === 'stat',
          patient: `${r.patient.name ? `${r.patient.name.toUpperCase()} ` : ''}(${r.patient.mrn})`,
          location: r.location ?? '',
          received: formatTime(r.receivedAt),
          test: r.test.name,
          code: r.test.localCode,
          loinc: r.test.loincCode ?? '',
          choice: r.test.resultType === 'ORDINAL' || r.test.resultType === 'NOMINAL',
          text: r.test.resultType === 'TEXT',
          unit: r.test.unit ?? '',
          answers: r.test.answers.map((a) => ({ code: a.code, display: a.display, abnormal: Boolean(a.abnormal), selected: mine && failed.value === a.code })),
          value: mine ? (failed.value ?? '') : '',
          performedBy: mine ? (failed.performedBy ?? '') : '',
          lot: mine ? (failed.lot ?? '') : '',
          issues: mine ? (failed.issues ?? []) : [],
        };
      }),
    });
  }

  @Post(':id')
  @Roles('technologist', 'approver')
  async enter(@Req() req: WebRequest, @Res() res: Response, @Param('id') id: string, @Body() body: Form): Promise<void> {
    const section = str(body, 'section');
    const input = { orderedTestId: uuidParam(id), value: str(body, 'value'), performedBy: str(body, 'performedBy'), lot: str(body, 'lot') };
    try {
      await enterManualResult(this.db, req.user!.username, input);
    } catch (e) {
      if (e instanceof InvalidInput) return this.render(req, res, section, { id: input.orderedTestId, issues: e.issues, value: input.value, performedBy: input.performedBy, lot: input.lot }, 422);
      throw e;
    }
    res.redirect(303, `/worksheet?notice=manual-entered${section ? `&section=${encodeURIComponent(section)}` : ''}`);
  }
}

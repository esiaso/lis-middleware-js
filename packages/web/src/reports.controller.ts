import { Body, Controller, Get, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Db } from '@lis/db';
import { parseTatTarget, TAT_PRIORITIES } from '@lis/domain';
import { addTatTarget, appendAudit, downtimeTestCatalogue, InvalidInput, overdueResults, parseTatFilter, retireTatTarget, summarizeTat, TAT_STEPS, tatTimes, workload, workloadCells, type TatFilter, type TatRow } from '@lis/lab';
import type { Response } from 'express';
import { page, requireStepUp, str, uuidParam, type Form } from './controllers.js';
import { elapsed, formatDuration, formatTime, STATUS_LABELS } from './format.js';
import { Roles, type WebRequest } from './security.js';
import { DB } from './tokens.js';

const day = (d: Date) => d.toISOString().slice(0, 10);
type Q = { from?: string | undefined; to?: string | undefined; priority?: string | undefined };
const q = (v: unknown) => (typeof v === 'string' ? v : undefined);

/** A spreadsheet must not run a cell as a formula (CSV injection). */
const cell = (v: string | null | undefined) => {
  const s = v ?? '';
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** Turnaround times (09, A-22) and workload (W-16). */
@Controller('reports')
export class ReportsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get('turnaround')
  async turnaround(@Req() req: WebRequest, @Res() res: Response, @Query() query: Record<string, unknown>): Promise<void> {
    const input: Q = { from: q(query['from']), to: q(query['to']), priority: q(query['priority']) };
    let f: TatFilter;
    let issues: string[] = [];
    try {
      f = parseTatFilter(input);
    } catch (e) {
      if (!(e instanceof InvalidInput)) throw e;
      issues = e.issues;
      f = parseTatFilter({});
    }
    const [rows, targets] = await Promise.all([tatTimes(this.db, f), this.db.tatTarget.findMany({ where: { active: true } })]);
    const s = summarizeTat(rows, targets);
    const view = (r: TatRow) => ({
      test: r.test,
      results: r.results,
      target: r.target.counted ? { met: r.target.met, late: r.target.late, counted: r.target.counted } : null,
      steps: TAT_STEPS.map((st) => {
        const x = r.steps[st.key];
        return { n: x.n, median: formatDuration(x.median), p90: formatDuration(x.p90), negative: x.negative };
      }),
    });
    const toDay = day(new Date(f.to.getTime() - 86_400_000));
    page(req, res, 'turnaround', {
      title: 'Turnaround times',
      issues,
      from: day(f.from),
      to: toDay,
      priorities: TAT_PRIORITIES.map((p) => ({ value: p, selected: p === f.priority })),
      steps: TAT_STEPS.map((st) => ({ label: st.label })),
      all: view(s.all),
      tests: s.tests.map(view),
      empty: rows.length === 0,
      hasTargets: targets.length > 0,
      csv: `/reports/turnaround.csv?from=${day(f.from)}&to=${toDay}${f.priority ? `&priority=${f.priority}` : ''}`,
    });
  }

  /** Unreleased results past their receipt-to-release target, most overdue first. */
  @Get('overdue')
  async overdue(@Req() req: WebRequest, @Res() res: Response): Promise<void> {
    const now = new Date();
    const [rows, targets] = await Promise.all([overdueResults(this.db, now), this.db.tatTarget.count({ where: { active: true } })]);
    page(req, res, 'overdue', {
      title: 'Overdue results',
      refresh: 60,
      hasTargets: targets > 0,
      rows: rows.slice(0, 500).map((r) => ({
        href: `/results/${r.resultId}`,
        patient: `${[r.familyName?.toUpperCase(), r.givenName].filter(Boolean).join(', ') || '(no name)'} (${r.mrn})`,
        test: r.test,
        priority: r.priority,
        accessionNo: r.accessionNo ?? '',
        status: STATUS_LABELS[r.status] ?? r.status,
        received: formatTime(r.received),
        target: formatDuration(r.targetMinutes * 60),
        late: elapsed(r.due, now),
      })),
      more: rows.length > 500 ? rows.length - 500 : 0,
    });
  }

  @Get('targets')
  async targets(@Req() req: WebRequest, @Res() res: Response): Promise<void> {
    await this.renderTargets(req, res, {}, []);
  }

  private async renderTargets(req: WebRequest, res: Response, v: Record<string, string>, issues: string[], status = 200): Promise<void> {
    const [targets, retired, tests] = await Promise.all([
      this.db.tatTarget.findMany({ where: { active: true }, orderBy: [{ localTestCode: 'asc' }, { priority: 'asc' }] }),
      this.db.tatTarget.findMany({ where: { active: false }, orderBy: { retiredAt: 'desc' }, take: 50 }),
      downtimeTestCatalogue(this.db),
    ]);
    const row = (t: (typeof targets)[number]) => ({
      id: t.id,
      test: t.localTestCode ?? 'every test',
      priority: t.priority ?? 'every priority',
      target: formatDuration(t.minutes * 60),
      reference: t.reference,
      by: t.createdBy,
      at: formatTime(t.createdAt),
      retiredBy: t.retiredBy ?? '',
      retiredAt: formatTime(t.retiredAt),
      retireReason: t.retireReason ?? '',
    });
    res.status(status);
    page(req, res, 'tat-targets', {
      title: 'Turnaround targets',
      targets: targets.map(row),
      retired: retired.map(row),
      tests: tests.map((code) => ({ code, selected: code === v['localTestCode'] })),
      priorities: TAT_PRIORITIES.map((p) => ({ value: p, selected: p === v['priority'] })),
      v,
      issues,
    });
  }

  @Post('targets')
  @Roles('approver')
  async addTarget(@Req() req: WebRequest, @Res() res: Response, @Body() body: Form): Promise<void> {
    const v = { localTestCode: str(body, 'localTestCode'), priority: str(body, 'priority'), minutes: str(body, 'minutes'), reference: str(body, 'reference') };
    const parsed = parseTatTarget(v);
    if (!parsed.ok) return this.renderTargets(req, res, v, parsed.issues, 422);
    await requireStepUp(this.db, req, str(body, 'password'));
    try {
      await addTatTarget(this.db, req.user!.username, v);
    } catch (e) {
      if (e instanceof InvalidInput) return this.renderTargets(req, res, v, e.issues, 422);
      throw e;
    }
    res.redirect(303, '/reports/targets?notice=target-added');
  }

  @Post('targets/:id/retire')
  @Roles('approver')
  async retireTarget(@Req() req: WebRequest, @Res() res: Response, @Param('id') id: string, @Body() body: Form): Promise<void> {
    await requireStepUp(this.db, req, str(body, 'password'));
    await retireTatTarget(this.db, req.user!.username, uuidParam(id), str(body, 'reason'));
    res.redirect(303, '/reports/targets?notice=target-retired');
  }

  /** One row per result, with accession number and times but no patient name or MRN. */
  /** What the instruments measured (W-16). Counts only, no patient data. */
  @Get('workload')
  async workload(@Req() req: WebRequest, @Res() res: Response, @Query() query: Record<string, unknown>): Promise<void> {
    let f: TatFilter;
    let issues: string[] = [];
    try {
      f = parseTatFilter({ from: q(query['from']), to: q(query['to']) });
    } catch (e) {
      if (!(e instanceof InvalidInput)) throw e;
      issues = e.issues;
      f = parseTatFilter({});
    }
    const w = await workload(this.db, f.from, f.to);
    const toDay = day(new Date(f.to.getTime() - 86_400_000));
    const columns = w.instruments.filter((i) => i.measurements > 0);
    page(req, res, 'workload', {
      title: 'Workload',
      issues,
      from: day(f.from),
      to: toDay,
      w,
      empty: w.total.measurements === 0 && w.total.qc === 0 && w.total.quarantined === 0,
      testColumns: columns.map((i) => ({ id: i.instrumentId, name: i.name })),
      tests: w.tests.map((t) => ({ ...t, cells: columns.map((i) => t.byInstrument[i.instrumentId] ?? 0) })),
      csv: `/reports/workload.csv?from=${day(f.from)}&to=${toDay}`,
    });
  }

  @Get('workload.csv')
  @Roles('approver', 'auditor')
  async workloadCsv(@Req() req: WebRequest, @Res() res: Response, @Query() query: Record<string, unknown>): Promise<void> {
    const f = parseTatFilter({ from: q(query['from']), to: q(query['to']) });
    const cells = await workloadCells(this.db, f.from, f.to);
    const names = new Map((await this.db.instrument.findMany({ select: { id: true, displayName: true } })).map((i) => [i.id, i.displayName]));
    const head = ['day', 'instrument_id', 'instrument', 'test', 'measurements', 'repeats'];
    const lines = cells.map((c) => [c.day, cell(c.instrumentId), cell(names.get(c.instrumentId) ?? ''), cell(c.test), c.measurements, c.repeats].join(','));
    await this.db.$transaction((tx) => appendAudit(tx, { actor: req.user!.username, action: 'report.workload-export', entityType: 'report', entityId: 'workload', after: { from: f.from.toISOString(), to: f.to.toISOString(), rows: cells.length } }));
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="workload-${day(f.from)}-to-${day(new Date(f.to.getTime() - 86_400_000))}.csv"`);
    res.setHeader('cache-control', 'no-store');
    res.send([head.join(','), ...lines].join('\r\n') + '\r\n');
  }

  @Get('turnaround.csv')
  @Roles('approver', 'auditor')
  async csv(@Req() req: WebRequest, @Res() res: Response, @Query() query: Record<string, unknown>): Promise<void> {
    const f = parseTatFilter({ from: q(query['from']), to: q(query['to']), priority: q(query['priority']) });
    const rows = await tatTimes(this.db, f);
    const iso = (d: Date | null) => (d ? d.toISOString() : '');
    const head = ['accession_no', 'test', 'priority', 'ordered', 'collected', 'received', 'first_value', 'approved', 'approved_by', 'released', 'accepted_by_hmis'];
    const lines = rows.map((r) => [cell(r.accessionNo), cell(r.test), cell(r.priority), iso(r.ordered), iso(r.collected), iso(r.received), iso(r.first_value), iso(r.approved), cell(r.approvedBy), iso(r.released), iso(r.accepted)].join(','));
    await this.db.$transaction((tx) => appendAudit(tx, { actor: req.user!.username, action: 'report.turnaround-export', entityType: 'report', entityId: 'turnaround', after: { from: f.from.toISOString(), to: f.to.toISOString(), priority: f.priority, rows: rows.length } }));
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="turnaround-${day(f.from)}-to-${day(new Date(f.to.getTime() - 86_400_000))}.csv"`);
    res.setHeader('cache-control', 'no-store');
    res.send([head.join(','), ...lines].join('\r\n') + '\r\n');
  }
}

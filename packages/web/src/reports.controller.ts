import { Controller, Get, Inject, Query, Req, Res } from '@nestjs/common';
import type { Db } from '@lis/db';
import { appendAudit, InvalidInput, parseTatFilter, summarizeTat, TAT_STEPS, tatTimes, type TatFilter, type TatRow } from '@lis/lab';
import type { Response } from 'express';
import { page } from './controllers.js';
import { formatDuration } from './format.js';
import { Roles, type WebRequest } from './security.js';
import { DB } from './tokens.js';

const PRIORITIES = ['routine', 'urgent', 'stat'];
const day = (d: Date) => d.toISOString().slice(0, 10);
type Q = { from?: string | undefined; to?: string | undefined; priority?: string | undefined };
const q = (v: unknown) => (typeof v === 'string' ? v : undefined);

/** A spreadsheet must not run a cell as a formula (CSV injection). */
const cell = (v: string | null | undefined) => {
  const s = v ?? '';
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** Turnaround times (09, A-22). */
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
    const rows = await tatTimes(this.db, f);
    const s = summarizeTat(rows);
    const view = (r: TatRow) => ({
      test: r.test,
      results: r.results,
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
      priorities: PRIORITIES.map((p) => ({ value: p, selected: p === f.priority })),
      steps: TAT_STEPS.map((st) => ({ label: st.label })),
      all: view(s.all),
      tests: s.tests.map(view),
      empty: rows.length === 0,
      csv: `/reports/turnaround.csv?from=${day(f.from)}&to=${toDay}${f.priority ? `&priority=${f.priority}` : ''}`,
    });
  }

  /** One row per result, with accession number and times but no patient name or MRN. */
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

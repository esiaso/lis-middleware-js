import { Body, Controller, Get, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Db } from '@lis/db';
import { parseTatTarget, TAT_PRIORITIES } from '@lis/domain';
import { addTatTarget, appendAudit, downtimeTestCatalogue, InvalidInput, labKpis, narrowTat, overdueResults, parseTatFilter, retireTatTarget, summarizeTat, TAT_GROUPS, TAT_ROLES, TAT_STEPS, tatTimes, workload, workloadCells, type TatFilter, type TatGroup, type TatNarrow, type TatRole, type TatRow } from '@lis/lab';
import type { Response } from 'express';
import { page, requireStepUp, str, uuidParam, type Form } from './controllers.js';
import { displayTimeZone, elapsed, formatDuration, formatTime, STATUS_LABELS } from './format.js';
import { Roles, type WebRequest } from './security.js';
import { DB } from './tokens.js';

type Q = { from?: string | undefined; to?: string | undefined; priority?: string | undefined };
const q = (v: unknown) => (typeof v === 'string' ? v : undefined);

/** A spreadsheet must not run a cell as a formula (CSV injection). */
const cell = (v: string | null | undefined) => {
  const s = v ?? '';
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

const GROUP_LABELS: [TatGroup, string][] = [['test', 'test'], ['instrument', 'instrument'], ['priority', 'priority'], ['day', 'day collected'], ['collectedBy', 'who collected'], ['receivedBy', 'who received'], ['enteredBy', 'who entered the result'], ['approvedBy', 'who approved'], ['releasedBy', 'who released']];

/** Test, instrument and staff narrowing from the query; anything unknown is ignored. */
function narrowOf(query: Record<string, unknown>): TatNarrow {
  const v = (k: string) => (q(query[k]) ?? '').trim().slice(0, 64);
  const role = v('role');
  return {
    ...(v('test') ? { test: v('test') } : {}),
    ...(v('instrument') ? { instrument: v('instrument') } : {}),
    ...(v('staff') ? { staff: v('staff') } : {}),
    ...(TAT_ROLES.some((r) => r.key === role) ? { role: role as TatRole } : {}),
  };
}

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
      f = parseTatFilter(input, new Date(), displayTimeZone());
    } catch (e) {
      if (!(e instanceof InvalidInput)) throw e;
      issues = e.issues;
      f = parseTatFilter({}, new Date(), displayTimeZone());
    }
    const n = narrowOf(query);
    const by: TatGroup = (TAT_GROUPS as readonly string[]).includes(q(query['by']) ?? '') ? (q(query['by']) as TatGroup) : 'test';
    const now = new Date();
    const [all, targets, instruments] = await Promise.all([tatTimes(this.db, f), this.db.tatTarget.findMany({ where: { active: true } }), this.db.instrument.findMany({ orderBy: { displayName: 'asc' } })]);
    const rows = narrowTat(all, n);
    const s = summarizeTat(rows, targets, now, by, displayTimeZone());
    const k = await labKpis(this.db, f, rows, targets, now);
    const staffIds = [...new Set(all.flatMap((r) => TAT_ROLES.map((x) => r[x.key])).filter((u): u is string => !!u && !u.startsWith('system:')))].sort();
    const people = new Map((await this.db.appUser.findMany({ where: { username: { in: staffIds } }, select: { username: true, displayName: true } })).map((u) => [u.username, u.displayName]));
    const instName = new Map(instruments.map((i) => [i.id, i.displayName]));
    const label = (key: string) => {
      if (by === 'instrument') return key === 'manual' ? 'Manual entry (no instrument)' : (instName.get(key) ?? key);
      if (TAT_ROLES.some((r) => r.key === by)) return key.startsWith('system:') ? (key === 'system:autoverify' ? 'autoverified' : 'the middleware') : (people.get(key) ?? key);
      return key;
    };
    const view = (r: TatRow) => ({
      test: r.test === 'All' ? r.test : label(r.test),
      results: r.results,
      target: r.target.counted ? { met: r.target.met, late: r.target.late, counted: r.target.counted } : null,
      steps: TAT_STEPS.map((st) => {
        const x = r.steps[st.key];
        return { n: x.n, median: formatDuration(x.median), p90: formatDuration(x.p90), negative: x.negative };
      }),
    });
    const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 1000) / 10}%` : '–');
    const keep = { from: f.fromDay, to: f.toDay, priority: f.priority ?? undefined, test: n.test, instrument: n.instrument, staff: n.staff, role: n.role };
    const qs = (extra: Record<string, string | undefined>) => new URLSearchParams(Object.entries({ ...keep, ...extra }).filter((e): e is [string, string] => !!e[1])).toString();
    page(req, res, 'turnaround', {
      title: 'Turnaround times',
      issues,
      from: f.fromDay,
      to: f.toDay,
      priorities: TAT_PRIORITIES.map((p) => ({ value: p, selected: p === f.priority })),
      tests: [...new Set(all.map((r) => r.test))].sort().map((t) => ({ value: t, selected: t === n.test })),
      instruments: [{ value: 'manual', label: 'Manual entry (no instrument)', selected: n.instrument === 'manual' }, ...instruments.map((i) => ({ value: i.id, label: i.displayName, selected: i.id === n.instrument }))],
      staff: staffIds.map((u) => ({ value: u, label: people.get(u) ? `${people.get(u)} (${u})` : u, selected: u === n.staff })),
      roles: TAT_ROLES.map((r) => ({ value: r.key, label: r.label, selected: r.key === n.role })),
      groups: GROUP_LABELS.map(([value, text]) => ({ value, label: text, selected: value === by, href: `/reports/turnaround?${qs({ by: value === 'test' ? undefined : value })}` })),
      byLabel: GROUP_LABELS.find(([v]) => v === by)?.[1] ?? 'test',
      narrowed: !!(n.test || n.instrument || n.staff),
      steps: TAT_STEPS.map((st) => ({ label: st.label })),
      headline: ['ordered_collected', 'collected_received', 'received_first', 'collected_released', 'ordered_released'].map((key) => {
        const st = TAT_STEPS.find((x) => x.key === key)!;
        const x = s.all.steps[st.key];
        return { label: st.label, median: formatDuration(x.median), p90: formatDuration(x.p90), n: x.n };
      }),
      kpi: {
        results: k.results,
        released: k.released,
        releasedPct: pct(k.released, k.results),
        target: k.target.counted ? { met: k.target.met, late: k.target.late, counted: k.target.counted, pct: pct(k.target.met, k.target.counted) } : null,
        autoverified: k.autoverified,
        autoverifiedPct: pct(k.autoverified, k.results),
        corrected: k.corrected,
        correctedPct: pct(k.corrected, k.results),
        specimens: k.specimens,
        rejected: k.rejected,
        rejectedPct: pct(k.rejected, k.specimens),
        reasons: k.rejectionReasons,
        critical: k.critical,
        criticalCalled: k.criticalCalled,
        callMedian: formatDuration(k.criticalCallMedian),
        callP90: formatDuration(k.criticalCallP90),
        overdueNow: k.overdueNow,
        sendOuts: { ...k.sendOuts, onTimePct: pct(k.sendOuts.onTime, k.sendOuts.onTime + k.sendOuts.late) },
      },
      all: view(s.all),
      groupsRows: s.tests.map(view),
      empty: rows.length === 0,
      hasTargets: targets.length > 0,
      csv: `/reports/turnaround.csv?${qs({})}`,
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
      f = parseTatFilter({ from: q(query['from']), to: q(query['to']) }, new Date(), displayTimeZone());
    } catch (e) {
      if (!(e instanceof InvalidInput)) throw e;
      issues = e.issues;
      f = parseTatFilter({}, new Date(), displayTimeZone());
    }
    const w = await workload(this.db, f.from, f.to, displayTimeZone());
    const toDay = f.toDay;
    const columns = w.instruments.filter((i) => i.measurements > 0);
    page(req, res, 'workload', {
      title: 'Workload',
      issues,
      from: f.fromDay,
      to: toDay,
      w,
      empty: w.total.measurements === 0 && w.total.qc === 0 && w.total.quarantined === 0,
      testColumns: columns.map((i) => ({ id: i.instrumentId, name: i.name })),
      tests: w.tests.map((t) => ({ ...t, cells: columns.map((i) => t.byInstrument[i.instrumentId] ?? 0) })),
      csv: `/reports/workload.csv?from=${f.fromDay}&to=${toDay}`,
    });
  }

  @Get('workload.csv')
  @Roles('approver', 'auditor')
  async workloadCsv(@Req() req: WebRequest, @Res() res: Response, @Query() query: Record<string, unknown>): Promise<void> {
    const f = parseTatFilter({ from: q(query['from']), to: q(query['to']) }, new Date(), displayTimeZone());
    const cells = await workloadCells(this.db, f.from, f.to, displayTimeZone());
    const names = new Map((await this.db.instrument.findMany({ select: { id: true, displayName: true } })).map((i) => [i.id, i.displayName]));
    const head = ['day', 'instrument_id', 'instrument', 'test', 'measurements', 'repeats'];
    const lines = cells.map((c) => [c.day, cell(c.instrumentId), cell(names.get(c.instrumentId) ?? ''), cell(c.test), c.measurements, c.repeats].join(','));
    await this.db.$transaction((tx) => appendAudit(tx, { actor: req.user!.username, action: 'report.workload-export', entityType: 'report', entityId: 'workload', after: { from: f.from.toISOString(), to: f.to.toISOString(), rows: cells.length } }));
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="workload-${f.fromDay}-to-${f.toDay}.csv"`);
    res.setHeader('cache-control', 'no-store');
    res.send([head.join(','), ...lines].join('\r\n') + '\r\n');
  }

  @Get('turnaround.csv')
  @Roles('approver', 'auditor')
  async csv(@Req() req: WebRequest, @Res() res: Response, @Query() query: Record<string, unknown>): Promise<void> {
    const f = parseTatFilter({ from: q(query['from']), to: q(query['to']), priority: q(query['priority']) }, new Date(), displayTimeZone());
    const n = narrowOf(query);
    const rows = narrowTat(await tatTimes(this.db, f), n);
    const iso = (d: Date | null) => (d ? d.toISOString() : '');
    const head = ['accession_no', 'test', 'priority', 'instrument', 'ordered', 'collected', 'collected_by', 'received', 'received_by', 'first_value', 'entered_by', 'approved', 'approved_by', 'released', 'released_by', 'accepted_by_hmis', 'corrected'];
    const lines = rows.map((r) => [cell(r.accessionNo), cell(r.test), cell(r.priority), cell(r.instrumentId), iso(r.ordered), iso(r.collected), cell(r.collectedBy), iso(r.received), cell(r.receivedBy), iso(r.first_value), cell(r.enteredBy), iso(r.approved), cell(r.approvedBy), iso(r.released), cell(r.releasedBy), iso(r.accepted), r.corrected ? 'yes' : ''].join(','));
    await this.db.$transaction((tx) => appendAudit(tx, { actor: req.user!.username, action: 'report.turnaround-export', entityType: 'report', entityId: 'turnaround', after: { from: f.from.toISOString(), to: f.to.toISOString(), priority: f.priority, ...n, rows: rows.length } }));
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="turnaround-${f.fromDay}-to-${f.toDay}.csv"`);
    res.setHeader('cache-control', 'no-store');
    res.send([head.join(','), ...lines].join('\r\n') + '\r\n');
  }
}

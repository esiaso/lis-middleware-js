import { Body, Controller, Get, Inject, NotFoundException, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { ResultValue } from '@lis/contracts';
import type { Db } from '@lis/db';
import { formatStat, parseQcRange, WESTGARD_LABEL, WESTGARD_RULES, zonedDay } from '@lis/domain';
import { addQcRange, appendAudit, downtimeTestCatalogue, failingQc, InvalidInput, parseTatFilter, qcSummary, retireQcRange, type QcSummaryRow, type TatFilter } from '@lis/lab';
import type { Response } from 'express';
import { page, requireStepUp, str, uuidParam, type Form } from './controllers.js';
import { displayTimeZone, formatTime, formatValue } from './format.js';
import { leveyJennings } from './levey-jennings.js';
import { Roles, type WebRequest } from './security.js';
import { DB } from './tokens.js';

const OUTCOME: Record<string, { label: string; tone: string }> = {
  IN_RANGE: { label: 'in range', tone: 'success' },
  OUT_OF_RANGE: { label: 'out of range', tone: 'danger' },
  RULE_VIOLATION: { label: 'Westgard', tone: 'danger' },
  UNITS_DIFFER: { label: 'units differ', tone: 'warning' },
  NO_RANGE: { label: 'no range', tone: 'secondary' },
  NOT_NUMERIC: { label: 'not compared', tone: 'secondary' },
};
const CHART_POINTS = 60;
const list = (raw: unknown): string[] => (Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : []).filter((x): x is string => typeof x === 'string');
/** A spreadsheet must not run a cell as a formula (CSV injection). */
const cell = (v: string | null | undefined) => {
  const s = v ?? '';
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
const q = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
/** The period asked for, or this month so far in the lab's time zone. */
const summaryPeriod = (query: Record<string, unknown>): TatFilter => {
  const tz = displayTimeZone();
  const today = zonedDay(new Date(), tz);
  return parseTatFilter({ from: q(query['from']) ?? `${today.slice(0, 8)}01`, to: q(query['to']) }, new Date(), tz);
};
/** Statistics with one decimal place more than the values carry. */
const shown = (r: QcSummaryRow) => {
  const p = r.places + 1;
  return {
    n: r.stats.n,
    mean: formatStat(r.stats.mean, p),
    sd: formatStat(r.stats.sd, p),
    cv: formatStat(r.stats.cvPercent, 1),
    min: formatStat(r.stats.min, r.places),
    max: formatStat(r.stats.max, r.places),
    bias: formatStat(r.stats.biasPercent, 1),
    shift: formatStat(r.stats.shiftSd, 2),
  };
};
const control = (c: { controlName: string | null; controlLot: string | null }) => [c.controlName, c.controlLot && `lot ${c.controlLot}`].filter(Boolean).join(', ') || '(not named)';

/** QC results from the instruments and the lab's acceptable ranges (08 §12, A-21). */
@Controller('qc')
export class QcController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  async log(@Req() req: WebRequest, @Res() res: Response, @Query('instrument') instrument?: string): Promise<void> {
    const filter = typeof instrument === 'string' && instrument ? instrument : undefined;
    const [failing, rows, instruments] = await Promise.all([
      failingQc(this.db),
      this.db.qcEvaluation.findMany({ where: filter ? { instrumentId: filter } : {}, orderBy: [{ at: 'desc' }, { id: 'desc' }], take: 200 }),
      this.db.instrument.findMany({ orderBy: { displayName: 'asc' }, select: { id: true, displayName: true } }),
    ]);
    const name = new Map(instruments.map((i) => [i.id, i.displayName]));
    page(req, res, 'qc', {
      title: 'QC',
      refresh: 60,
      failing: failing.map((f) => ({ instrument: f.instrumentName, test: f.localTestCode, control: control(f), detail: f.detail, at: formatTime(f.at) })),
      instruments: instruments.map((i) => ({ id: i.id, name: i.displayName, selected: i.id === filter })),
      rows: rows.map((e) => ({
        at: formatTime(e.at),
        instrument: name.get(e.instrumentId) ?? e.instrumentId,
        test: e.localTestCode ?? '',
        control: control(e),
        level: e.controlLevel ?? '',
        value: formatValue(e.value as unknown as ResultValue),
        units: e.units ?? '',
        outcome: OUTCOME[e.outcome] ?? { label: e.outcome, tone: 'secondary' },
        warn: e.westgardWarn.length > 0 && e.outcome === 'IN_RANGE',
        rangeId: e.rangeId,
        detail: e.detail,
      })),
    });
  }

  /** Observed mean, SD and CV per range over a period (A-28, W-20). */
  @Get('summary')
  async summary(@Req() req: WebRequest, @Res() res: Response, @Query() query: Record<string, unknown>): Promise<void> {
    let f: TatFilter;
    let issues: string[] = [];
    try {
      f = summaryPeriod(query);
    } catch (e) {
      if (!(e instanceof InvalidInput)) throw e;
      issues = e.issues;
      f = summaryPeriod({});
    }
    const rows = await qcSummary(this.db, f.from, f.to);
    page(req, res, 'qc-summary', {
      title: 'QC summary',
      issues,
      from: f.fromDay,
      to: f.toDay,
      rows: rows.map((r) => ({
        rangeId: r.rangeId, instrument: r.instrument, test: r.test, control: control(r), units: r.units, limits: `${r.low} to ${r.high}`,
        target: r.targetMean && r.targetSd ? `${r.targetMean} ± ${r.targetSd}` : '', active: r.active,
        rejected: r.rejected, warnings: r.warnings, notCompared: r.notCompared, ...shown(r),
      })),
      csv: `/qc/summary.csv?from=${f.fromDay}&to=${f.toDay}`,
    });
  }

  @Get('summary.csv')
  @Roles('approver', 'auditor')
  async summaryCsv(@Req() req: WebRequest, @Res() res: Response, @Query() query: Record<string, unknown>): Promise<void> {
    const f = summaryPeriod(query);
    const rows = await qcSummary(this.db, f.from, f.to);
    const head = ['instrument_id', 'instrument', 'test', 'control_name', 'control_lot', 'units', 'low', 'high', 'target_mean', 'target_sd', 'range_active', 'n', 'mean', 'sd', 'cv_percent', 'min', 'max', 'bias_percent', 'shift_sd', 'rejected', 'warnings', 'not_compared'];
    const lines = rows.map((r) => {
      const s = shown(r);
      return [cell(r.instrumentId), cell(r.instrument), cell(r.test), cell(r.controlName), cell(r.controlLot), cell(r.units), r.low, r.high, r.targetMean ?? '', r.targetSd ?? '', r.active ? 'yes' : 'no', s.n, s.mean, s.sd, s.cv, s.min, s.max, s.bias, s.shift, r.rejected, r.warnings, r.notCompared].join(',');
    });
    await this.db.$transaction((tx) => appendAudit(tx, { actor: req.user!.username, action: 'report.qc-summary-export', entityType: 'report', entityId: 'qc-summary', after: { from: f.from.toISOString(), to: f.to.toISOString(), rows: rows.length } }));
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="qc-summary-${f.fromDay}-to-${f.toDay}.csv"`);
    res.setHeader('cache-control', 'no-store');
    res.send([head.join(','), ...lines].join('\r\n') + '\r\n');
  }

  @Get('ranges')
  async ranges(@Req() req: WebRequest, @Res() res: Response): Promise<void> {
    await this.renderRanges(req, res, {}, []);
  }

  private async renderRanges(req: WebRequest, res: Response, v: Record<string, string>, issues: string[], status = 200, rules: string[] = []): Promise<void> {
    const [ranges, retired, tests, instruments] = await Promise.all([
      this.db.qcRange.findMany({ where: { active: true }, orderBy: [{ instrumentId: 'asc' }, { localTestCode: 'asc' }, { createdAt: 'asc' }], include: { instrument: { select: { displayName: true } } } }),
      this.db.qcRange.findMany({ where: { active: false }, orderBy: { retiredAt: 'desc' }, take: 50, include: { instrument: { select: { displayName: true } } } }),
      downtimeTestCatalogue(this.db),
      this.db.instrument.findMany({ orderBy: { displayName: 'asc' }, select: { id: true, displayName: true } }),
    ]);
    const row = (r: (typeof ranges)[number]) => ({
      id: r.id,
      instrument: r.instrument.displayName,
      test: r.localTestCode,
      control: control(r),
      low: r.low,
      high: r.high,
      units: r.units,
      target: r.targetMean && r.targetSd ? `${r.targetMean} ± ${r.targetSd}` : '',
      rules: r.westgardRules.join(', '),
      reference: r.reference,
      by: r.createdBy,
      at: formatTime(r.createdAt),
      retiredBy: r.retiredBy ?? '',
      retiredAt: formatTime(r.retiredAt),
      retireReason: r.retireReason ?? '',
    });
    res.status(status);
    page(req, res, 'qc-ranges', {
      title: 'QC ranges',
      ranges: ranges.map(row),
      retired: retired.map(row),
      tests: tests.map((code) => ({ code, selected: code === v['localTestCode'] })),
      instruments: instruments.map((i) => ({ id: i.id, name: i.displayName, selected: i.id === v['instrumentId'] })),
      westgard: WESTGARD_RULES.map((r) => ({ value: r, label: WESTGARD_LABEL[r], checked: rules.includes(r) })),
      v,
      issues,
    });
  }

  /** Levey-Jennings chart of one range's latest QC results (W-15). */
  @Get('ranges/:id/chart')
  async chart(@Req() req: WebRequest, @Res() res: Response, @Param('id') id: string): Promise<void> {
    const r = await this.db.qcRange.findUnique({ where: { id: uuidParam(id) }, include: { instrument: { select: { displayName: true } } } });
    if (!r) throw new NotFoundException();
    const evals = await this.db.qcEvaluation.findMany({
      where: { rangeId: r.id, outcome: { in: ['IN_RANGE', 'OUT_OF_RANGE', 'RULE_VIOLATION'] } },
      orderBy: [{ at: 'desc' }, { id: 'desc' }],
      take: CHART_POINTS,
    });
    const rows = evals
      .reverse()
      .map((e) => ({ e, v: e.value as unknown as ResultValue }))
      .filter((x): x is { e: (typeof evals)[number]; v: Extract<ResultValue, { kind: 'numeric' }> } => x.v.kind === 'numeric')
      .map(({ e, v }) => ({
        value: Number(v.value),
        at: formatTime(e.at),
        outcome: e.outcome,
        label: `${v.value} ${e.units ?? ''}${e.zScore !== null ? `, z ${e.zScore.toFixed(2)}` : ''}${e.westgardReject.length ? `, breaks ${e.westgardReject.join(', ')}` : ''}${e.westgardWarn.length ? `, warning ${e.westgardWarn.join(', ')}` : ''}`,
        shown: `${v.value} ${e.units ?? ''}`,
        badge: OUTCOME[e.outcome] ?? { label: e.outcome, tone: 'secondary' },
        detail: e.detail,
      }));
    const chart = leveyJennings({ low: Number(r.low), high: Number(r.high), mean: r.targetMean === null ? null : Number(r.targetMean), sd: r.targetSd === null ? null : Number(r.targetSd) }, rows);
    page(req, res, 'qc-chart', {
      title: 'QC chart',
      range: {
        instrument: r.instrument.displayName, test: r.localTestCode, control: control(r), low: r.low, high: r.high, units: r.units,
        target: r.targetMean && r.targetSd ? `${r.targetMean} ± ${r.targetSd}` : '', rules: r.westgardRules.join(', '), active: r.active,
      },
      chart,
      rows: [...rows].reverse(),
      limit: CHART_POINTS,
    });
  }

  @Post('ranges')
  @Roles('approver')
  async add(@Req() req: WebRequest, @Res() res: Response, @Body() body: Form): Promise<void> {
    const keys = ['instrumentId', 'localTestCode', 'controlLot', 'controlName', 'low', 'high', 'units', 'reference', 'targetMean', 'targetSd'] as const;
    const v = Object.fromEntries(keys.map((k) => [k, str(body, k)])) as Record<(typeof keys)[number], string>;
    const westgardRules = list(body['westgardRules']);
    const input = { ...v, westgardRules };
    const parsed = parseQcRange(input);
    if (!parsed.ok) return this.renderRanges(req, res, v, parsed.issues, 422, westgardRules);
    await requireStepUp(this.db, req, str(body, 'password'));
    try {
      await addQcRange(this.db, req.user!.username, input);
    } catch (e) {
      if (e instanceof InvalidInput) return this.renderRanges(req, res, v, e.issues, 422, westgardRules);
      throw e;
    }
    res.redirect(303, '/qc/ranges?notice=qc-range-added');
  }

  @Post('ranges/:id/retire')
  @Roles('approver')
  async retire(@Req() req: WebRequest, @Res() res: Response, @Param('id') id: string, @Body() body: Form): Promise<void> {
    await requireStepUp(this.db, req, str(body, 'password'));
    await retireQcRange(this.db, req.user!.username, uuidParam(id), str(body, 'reason'));
    res.redirect(303, '/qc/ranges?notice=qc-range-retired');
  }
}

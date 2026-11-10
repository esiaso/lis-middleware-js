import { Body, Controller, Get, Inject, NotFoundException, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Db } from '@lis/db';
import { answersText, type CatalogueForm } from '@lis/domain';
import {
  activeCatalogue, activeEntry, approveCatalogueEntry, catalogueDrafts, discardCatalogueDraft, enterManualPanel, enterManualResult, InvalidInput, manualWorksheet,
  passingLots, proposeCatalogueEntry, qcGoverning, recentManualQc, recordManualQc, retireCatalogueEntry, type CatalogueEntry, type WorksheetRow,
} from '@lis/lab';
import type { Response } from 'express';
import { page, requireStepUp, str, uuidParam, type Form } from './controllers.js';
import { formatTime } from './format.js';
import { Roles, type WebRequest } from './security.js';
import { DB } from './tokens.js';

const FIELDS = ['localCode', 'name', 'section', 'loincCode', 'loincDisplay', 'shaCode', 'specimenType', 'performedBy', 'resultType', 'answers', 'unit', 'decimals', 'components', 'qcRule', 'qcValidHours'] as const;
const TYPE_WORDS: Record<string, string> = { NUMERIC: 'Number', ORDINAL: 'Ordered choice', NOMINAL: 'Choice', TEXT: 'Text', PANEL: 'Panel' };

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
  components: (e.components ?? []).join('\n'),
  qcRule: e.qcRule ?? 'NONE',
  qcValidHours: e.qcValidHours === undefined ? '' : String(e.qcValidHours),
});
const QC_WORDS: Record<string, string> = { NONE: 'No check', WARN: 'Warn without a passing control', BLOCK: 'Block without a passing control' };
const qcText = (e: CatalogueEntry) =>
  e.qcRule ? `${e.qcRule === 'BLOCK' ? 'blocks' : 'warns'} without a passing control for the lot${e.qcValidHours ? `, each ${e.qcValidHours} h` : ''}` : '';

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
  components: e.components ?? [],
  qc: qcText(e),
  reason: e.changeReason,
  by: e.createdBy,
  at: formatTime(e.createdAt),
  approvedBy: e.approvedBy ?? '',
  approvedAt: formatTime(e.approvedAt ?? null),
});

/** One answer row on the form: code, words, flag and LOINC answer code. */
interface AnswerRow { n: number; code: string; display: string; flag: string; la: string }

/** The answer rows of the form's answer text (one `code | words | flag | LA` per line). */
function rowsOf(text: string): AnswerRow[] {
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((line, i) => {
    const [code = '', display = '', ...rest] = line.split('|').map((p) => p.trim());
    const flag = rest.find((r) => /^(abnormal|critical)$/i.test(r))?.toLowerCase() ?? '';
    const la = rest.find((r) => !/^(abnormal|critical)$/i.test(r)) ?? '';
    return { n: i, code, display, flag, la };
  });
}

/** The answer text from the row editor (`answer-N-code` and so on), or the plain `answers` text when that was sent. */
function answersFrom(body: Form): string {
  const ns = Object.keys(body ?? {}).map((k) => /^answer-(\d{1,3})-code$/.exec(k)?.[1]).filter((n): n is string => n !== undefined).map(Number).sort((a, b) => a - b);
  if (!ns.length) return str(body, 'answers');
  return ns
    .map((n) => [str(body, `answer-${n}-code`).trim(), str(body, `answer-${n}-display`).trim(), str(body, `answer-${n}-flag`).trim(), str(body, `answer-${n}-la`).trim()])
    .filter(([code, display]) => code || display)
    .map(([code, display, flag, la]) => [code, display, ...(flag ? [flag] : []), ...(la ? [la] : [])].join(' | '))
    .join('\n');
}

const BLANK: CatalogueForm = { localCode: '', name: '', section: '', loincCode: '', loincDisplay: '', shaCode: '', specimenType: '', performedBy: 'MANUAL', resultType: 'NUMERIC', answers: '', unit: '', decimals: '', components: '', qcRule: 'NONE', qcValidHours: '' };
const FLAGS = [{ value: '', label: 'Normal' }, { value: 'abnormal', label: 'Abnormal' }, { value: 'critical', label: 'Critical' }];
const TYPE_HINTS: Record<string, string> = { NUMERIC: 'A measured number', ORDINAL: 'Answers in order (Neg, Trace, 1+)', NOMINAL: 'Answers in no order', TEXT: 'Free text', PANEL: 'A group of tests' };

/** The lab's test catalogue with LOINC codes (design: "Test catalogue and LOINC"). */
@Controller('catalogue')
export class CatalogueController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  async list(
    @Req() req: WebRequest,
    @Res() res: Response,
    @Query('edit') edit?: string,
    @Query('q') q?: string,
    @Query('bench') bench?: string,
    @Query('by') by?: string,
  ): Promise<void> {
    // The old address of the edit form still works.
    if (typeof edit === 'string' && edit) return res.redirect(303, `/catalogue/${encodeURIComponent(edit)}/edit`);
    const [active, drafts] = await Promise.all([activeCatalogue(this.db), catalogueDrafts(this.db)]);
    const query = typeof q === 'string' ? q.trim() : '';
    const benchSel = typeof bench === 'string' ? bench : '';
    const bySel = by === 'MANUAL' || by === 'INSTRUMENT' ? by : '';
    const needle = query.toLowerCase();
    const shown = active.filter(
      (e) =>
        (!benchSel || e.section === benchSel) &&
        (!bySel || e.performedBy === bySel) &&
        (!needle || [e.localCode, e.name, e.loincCode ?? '', e.loincDisplay ?? '', e.shaCode ?? ''].some((t) => t.toLowerCase().includes(needle))),
    );
    const roles = req.user?.roles ?? [];
    page(req, res, 'catalogue', {
      title: 'Test catalogue',
      tests: shown.map(view),
      total: active.length,
      filtered: shown.length !== active.length,
      q: query,
      benches: [...new Set(active.map((e) => e.section))].sort().map((b) => ({ name: b, selected: b === benchSel })),
      by: [
        { value: 'MANUAL', label: 'By a person', selected: bySel === 'MANUAL' },
        { value: 'INSTRUMENT', label: 'By an instrument', selected: bySel === 'INSTRUMENT' },
      ],
      drafts: drafts.map((d) => ({ ...view(d), mine: d.createdBy === req.user?.username })),
      canEdit: roles.includes('admin') || roles.includes('approver'),
    });
  }

  @Get('new')
  @Roles('admin', 'approver')
  async create(@Req() req: WebRequest, @Res() res: Response): Promise<void> {
    await this.form(req, res, BLANK, [], '', false);
  }

  @Get(':code/edit')
  @Roles('admin', 'approver')
  async edit(@Req() req: WebRequest, @Res() res: Response, @Param('code') code: string): Promise<void> {
    const current = await activeEntry(this.db, code);
    if (!current) throw new NotFoundException();
    await this.form(req, res, formOf(current), [], '', true);
  }

  private async form(req: WebRequest, res: Response, v: CatalogueForm, issues: string[], reason: string, editing: boolean, status = 200): Promise<void> {
    const active = await activeCatalogue(this.db);
    const rows = rowsOf(v.answers);
    const blanks = Math.max(2, 6 - rows.length);
    for (let i = 0; i < blanks; i++) rows.push({ n: rows.length, code: '', display: '', flag: '', la: '' });
    res.status(status);
    page(req, res, 'catalogue-form', {
      title: editing ? `Change ${v.localCode}` : 'Add a test',
      editing,
      v,
      reason,
      issues,
      benches: [...new Set(active.map((e) => e.section))].sort(),
      specimens: [...new Set(active.map((e) => e.specimenType).filter(Boolean))].sort(),
      others: active.filter((e) => e.resultType !== 'PANEL' && e.localCode !== v.localCode).map((e) => ({ code: e.localCode, name: e.name })),
      answerRows: rows.map((r) => ({ ...r, flags: FLAGS.map((f) => ({ ...f, selected: f.value === r.flag })) })),
      performed: [
        { value: 'MANUAL', label: 'A person', hint: 'Read at the bench and entered on the worksheet', checked: v.performedBy === 'MANUAL' },
        { value: 'INSTRUMENT', label: 'An instrument', hint: 'Sent by an analyser through its mapping', checked: v.performedBy === 'INSTRUMENT' },
      ],
      qcRules: Object.entries(QC_WORDS).map(([value, label]) => ({ value, label, selected: (v.qcRule || 'NONE') === value })),
      types: Object.entries(TYPE_WORDS).map(([value, label]) => ({ value, label, hint: TYPE_HINTS[value] ?? '', checked: v.resultType === value })),
    });
  }

  @Post()
  @Roles('admin', 'approver')
  async propose(@Req() req: WebRequest, @Res() res: Response, @Body() body: Form): Promise<void> {
    const f = { ...formFrom(body), answers: answersFrom(body) };
    try {
      await proposeCatalogueEntry(this.db, req.user!.username, f, str(body, 'reason'));
    } catch (e) {
      if (e instanceof InvalidInput) {
        const editing = Boolean(f.localCode && (await activeEntry(this.db, f.localCode.trim().toUpperCase())));
        return this.form(req, res, f, e.issues, str(body, 'reason'), editing, 422);
      }
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

/** A refused entry, shown again on its card with the reason. */
interface Failed {
  ids?: string[];
  issues?: string[];
  values?: Map<string, string>;
  performedBy?: string;
  lot?: string;
}

/** One card per ordinary test, and one per panel order line holding its components waiting for a person. */
/** What QC a card needs: the governing test or panel, its rule, and the lots that may be used now (A-33). */
type CardQc = (r: WorksheetRow) => { code: string; block: boolean; lots: string[] } | null;

function cardsOf(rows: WorksheetRow[], failed: Failed, qcOf: CardQc = () => null) {
  const field = (r: WorksheetRow) => {
    const value = failed.values?.get(r.orderedTestId) ?? '';
    return {
      id: r.orderedTestId,
      test: r.test.name,
      code: r.test.localCode,
      loinc: r.test.loincCode ?? '',
      choice: r.test.resultType === 'ORDINAL' || r.test.resultType === 'NOMINAL',
      text: r.test.resultType === 'TEXT',
      unit: r.test.unit ?? '',
      answers: r.test.answers.map((a) => ({ code: a.code, display: a.display, abnormal: Boolean(a.abnormal), critical: Boolean(a.critical), selected: value === a.code })),
      value,
    };
  };
  const cards: Record<string, unknown>[] = [];
  const byLine = new Map<string, Record<string, unknown> & { fields: ReturnType<typeof field>[] }>();
  for (const r of rows) {
    const key = r.panel ? `${r.orderId}/${r.hmisLineId}` : r.orderedTestId;
    const mine = failed.ids?.includes(r.orderedTestId) ?? false;
    let card = byLine.get(key);
    if (!card) {
      card = {
        panel: r.panel,
        accessionNo: r.accessionNo,
        stat: r.priority === 'stat',
        patient: `${r.patient.name ? `${r.patient.name.toUpperCase()} ` : ''}(${r.patient.mrn})`,
        location: r.location ?? '',
        received: formatTime(r.receivedAt),
        action: r.panel ? '/worksheet/panel' : `/worksheet/${r.orderedTestId}`,
        performedBy: '',
        lot: '',
        qc: qcOf(r),
        issues: [] as string[],
        fields: [],
      };
      byLine.set(key, card);
      cards.push(card);
    }
    if (mine) Object.assign(card, { performedBy: failed.performedBy ?? '', lot: failed.lot ?? '', issues: failed.issues ?? [] });
    card.fields.push(field(r));
  }
  return cards;
}

/** The bench worksheet for tests read by a person (design: "Manual tests"). */
@Controller('worksheet')
export class WorksheetController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  async list(@Req() req: WebRequest, @Res() res: Response, @Query('section') section?: string): Promise<void> {
    await this.render(req, res, typeof section === 'string' ? section : '', {}, 200);
  }

  private async render(req: WebRequest, res: Response, section: string, failed: Failed, status: number): Promise<void> {
    const [all, rows, lots] = await Promise.all([activeCatalogue(this.db), manualWorksheet(this.db, section ? { section } : {}), passingLots(this.db)]);
    const byCode = new Map(all.map((e) => [e.localCode, e]));
    const qcOf: CardQc = (r) => {
      const g = qcGoverning(r.test, r.panel ? (byCode.get(r.panel.code) ?? null) : null);
      return g ? { code: g.localCode, block: g.qcRule === 'BLOCK', lots: lots.get(g.localCode) ?? [] } : null;
    };
    const sections = [...new Set(all.filter((e) => e.performedBy === 'MANUAL').map((e) => e.section))].sort();
    res.status(status);
    page(req, res, 'worksheet', {
      title: 'Manual worksheet',
      sections: sections.map((s) => ({ name: s, selected: s === section })),
      section,
      anyManual: sections.length > 0,
      cards: cardsOf(rows, failed, qcOf),
    });
  }

  @Get('qc')
  async qc(@Req() req: WebRequest, @Res() res: Response, @Query('test') test?: string): Promise<void> {
    await this.renderQc(req, res, typeof test === 'string' ? test : '', {}, [], 200);
  }

  private async renderQc(req: WebRequest, res: Response, code: string, v: Record<string, string>, issues: string[], status: number): Promise<void> {
    const [all, recent, lots] = await Promise.all([activeCatalogue(this.db), recentManualQc(this.db, { take: 100 }), passingLots(this.db)]);
    const manual = all.filter((e) => e.performedBy === 'MANUAL');
    const def = manual.find((e) => e.localCode === code) ?? null;
    const coded = def ? def.resultType === 'ORDINAL' || def.resultType === 'NOMINAL' : false;
    const names = new Map(all.map((e) => [e.localCode, e.name]));
    const answers = (sel: string) => (def?.answers ?? []).map((a) => ({ code: a.code, display: a.display, selected: sel === a.code }));
    res.status(status);
    page(req, res, 'manual-qc', {
      title: 'Manual QC',
      tests: manual.map((e) => ({ code: e.localCode, name: e.name, rule: e.qcRule ? (e.qcRule === 'BLOCK' ? 'blocks' : 'warns') : '', selected: e.localCode === code })),
      def: def ? { code: def.localCode, name: def.name, coded, panel: def.resultType === 'PANEL', rule: def.qcRule ?? '', hours: def.qcValidHours ?? '' } : null,
      expected: answers(v['expected'] ?? ''),
      observed: answers(v['observed'] ?? ''),
      v,
      issues,
      usable: manual.filter((e) => e.qcRule).map((e) => ({ code: e.localCode, name: e.name, block: e.qcRule === 'BLOCK', hours: e.qcValidHours ?? '', lots: lots.get(e.localCode) ?? [] })),
      recent: recent.map((r) => ({
        ...r,
        name: names.get(r.localCode) ?? r.localCode,
        pass: r.outcome === 'PASS',
        at: formatTime(r.at),
        lotExpiry: r.lotExpiry ? r.lotExpiry.toISOString().slice(0, 10) : '',
      })),
    });
  }

  @Post('qc')
  @Roles('technologist', 'approver')
  async recordQc(@Req() req: WebRequest, @Res() res: Response, @Body() body: Form): Promise<void> {
    const keys = ['localCode', 'lot', 'lotExpiry', 'control', 'expected', 'observed', 'outcome', 'performedBy', 'comment'] as const;
    const v = Object.fromEntries(keys.map((k) => [k, str(body, k)])) as Record<(typeof keys)[number], string>;
    try {
      await recordManualQc(this.db, req.user!.username, v);
    } catch (e) {
      if (e instanceof InvalidInput) return this.renderQc(req, res, v.localCode, v, e.issues, 422);
      throw e;
    }
    res.redirect(303, `/worksheet/qc?notice=manual-qc-recorded&test=${encodeURIComponent(v.localCode)}`);
  }

  @Post('panel')
  @Roles('technologist', 'approver')
  async enterPanel(@Req() req: WebRequest, @Res() res: Response, @Body() body: Form): Promise<void> {
    const section = str(body, 'section');
    const values = Object.keys(body ?? {})
      .filter((k) => k.startsWith('value-'))
      .map((k) => ({ orderedTestId: uuidParam(k.slice('value-'.length)), value: str(body, k) }));
    const performedBy = str(body, 'performedBy');
    const lot = str(body, 'lot');
    try {
      await enterManualPanel(this.db, req.user!.username, { values, performedBy, lot });
    } catch (e) {
      if (e instanceof InvalidInput) return this.render(req, res, section, { ids: values.map((v) => v.orderedTestId), issues: e.issues, values: new Map(values.map((v) => [v.orderedTestId, v.value])), performedBy, lot }, 422);
      throw e;
    }
    res.redirect(303, `/worksheet?notice=manual-entered${section ? `&section=${encodeURIComponent(section)}` : ''}`);
  }

  @Post(':id')
  @Roles('technologist', 'approver')
  async enter(@Req() req: WebRequest, @Res() res: Response, @Param('id') id: string, @Body() body: Form): Promise<void> {
    const section = str(body, 'section');
    const input = { orderedTestId: uuidParam(id), value: str(body, 'value'), performedBy: str(body, 'performedBy'), lot: str(body, 'lot') };
    try {
      await enterManualResult(this.db, req.user!.username, input);
    } catch (e) {
      if (e instanceof InvalidInput) return this.render(req, res, section, { ids: [input.orderedTestId], issues: e.issues, values: new Map([[input.orderedTestId, input.value]]), performedBy: input.performedBy, lot: input.lot }, 422);
      throw e;
    }
    res.redirect(303, `/worksheet?notice=manual-entered${section ? `&section=${encodeURIComponent(section)}` : ''}`);
  }
}

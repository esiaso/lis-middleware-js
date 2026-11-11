import { Body, Controller, Get, Inject, Post, Query, Req, Res } from '@nestjs/common';
import type { Db } from '@lis/db';
import { InvalidInput, transcribeResults, transcribeWorksheet, type TranscribeCard } from '@lis/lab';
import type { Response } from 'express';
import { page, str, uuidParam, type Form } from './controllers.js';
import { formatTime } from './format.js';
import { Roles, type WebRequest } from './security.js';
import { DB } from './tokens.js';

/** A refused card, shown again with what was typed and why it was refused. */
interface Failed {
  specimenId?: string;
  issues?: string[];
  values?: Map<string, string>;
  fields?: Record<string, string>;
}

/** Instrument downtime: type an analyser's results in from its printout (A-41, W-25). */
@Controller('transcribe')
export class TranscribeController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  async list(@Req() req: WebRequest, @Res() res: Response, @Query('accession') accession?: string): Promise<void> {
    await this.render(req, res, typeof accession === 'string' ? accession.trim().slice(0, 20) : '', {}, 200);
  }

  private async render(req: WebRequest, res: Response, accession: string, failed: Failed, status: number): Promise<void> {
    const [cards, instruments] = await Promise.all([
      transcribeWorksheet(this.db, accession ? { accessionNo: accession } : {}),
      this.db.instrument.findMany({ orderBy: { displayName: 'asc' } }),
    ]);
    const view = (c: TranscribeCard) => {
      const mine = failed.specimenId === c.specimenId;
      const f = mine ? (failed.fields ?? {}) : {};
      return {
        ...c,
        stat: c.priority === 'stat',
        received: formatTime(c.receivedAt),
        issues: mine ? (failed.issues ?? []) : [],
        runRef: f['runRef'] ?? '',
        reason: f['reason'] ?? '',
        performedBy: f['performedBy'] ?? '',
        instruments: instruments.map((i) => ({ id: i.id, name: i.displayName, selected: f['instrumentId'] === i.id })),
        tests: c.tests.map((t) => ({
          id: t.orderedTestId,
          code: t.test.localCode,
          name: t.test.name,
          unit: t.test.unit ?? '',
          panel: t.panel?.code ?? '',
          choice: t.test.resultType === 'ORDINAL' || t.test.resultType === 'NOMINAL',
          answers: t.test.answers.map((a) => ({ code: a.code, display: a.display, selected: (failed.values?.get(t.orderedTestId) ?? '') === a.code })),
          value: mine ? (failed.values?.get(t.orderedTestId) ?? '') : '',
        })),
      };
    };
    res.status(status);
    page(req, res, 'transcribe', {
      title: 'Instrument down',
      accession,
      cards: cards.map(view),
      // Shown at the top when the refused card is not on the page (it was filtered out or the form lost its specimen).
      issues: failed.issues && !cards.some((c) => c.specimenId === failed.specimenId) ? failed.issues : [],
      anyInstrument: instruments.length > 0,
    });
  }

  @Post()
  @Roles('technologist', 'approver')
  async enter(@Req() req: WebRequest, @Res() res: Response, @Body() body: Form): Promise<void> {
    const values = Object.keys(body ?? {})
      .filter((k) => k.startsWith('value-'))
      .map((k) => ({ orderedTestId: uuidParam(k.slice('value-'.length)), value: str(body, k) }));
    const fields = { instrumentId: str(body, 'instrumentId'), runRef: str(body, 'runRef'), reason: str(body, 'reason'), performedBy: str(body, 'performedBy') };
    const accession = str(body, 'accession');
    try {
      await transcribeResults(this.db, req.user!.username, { ...fields, values });
    } catch (e) {
      if (e instanceof InvalidInput) {
        return this.render(req, res, accession, { specimenId: str(body, 'specimenId'), issues: e.issues, values: new Map(values.map((v) => [v.orderedTestId, v.value])), fields }, 422);
      }
      throw e;
    }
    res.redirect(303, `/transcribe?notice=transcribed${accession ? `&accession=${encodeURIComponent(accession)}` : ''}`);
  }
}

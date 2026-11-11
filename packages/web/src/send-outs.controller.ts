import { Body, Controller, Get, Inject, NotFoundException, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Db } from '@lis/db';
import { fromZonedLocal, zonedLocal } from '@lis/domain';
import {
  activeEntry, addSendOutDocument, cancelSendOut, createSendOut, DOCUMENT_MAX_BYTES, enterSendOutResults, InvalidInput, recordReferralReceipt, sendOutDocument, sendOutWorklist, sentTests, type SendCard, type SendOutState,
} from '@lis/lab';
import type { Response } from 'express';
import { page, str, uuidParam, type Form } from './controllers.js';
import { displayTimeZone, formatTime, formatValue } from './format.js';
import { PAGE_SIZE, pageParam, pagerFor, pageWindow } from './paging.js';
import { Roles, type WebRequest } from './security.js';
import { DB } from './tokens.js';
import { fileUpload, type UploadRequest } from './uploads.js';

/** The document form, read before the guards run (see fileUpload). */
export const documentUpload = () => fileUpload('file', DOCUMENT_MAX_BYTES, 'The file can be at most 5 MB. Scan it at a lower resolution or as a PDF and try again.');

const STATES: [SendOutState, string][] = [['overdue', 'Overdue'], ['awaiting', 'Awaiting result'], ['late', 'Resulted late'], ['on-time', 'Resulted on time'], ['cancelled', 'Cancelled']];
const KIND_LABEL: Record<string, string> = { 'receiving-report': 'Receiving report', 'result-report': 'Result report', other: 'Other' };
const hours = (h: number) => (h % 24 === 0 ? `${h / 24} day${h === 24 ? '' : 's'}` : `${h} h`);
const span = (h: number) => (h >= 48 ? `${Math.round((h / 24) * 10) / 10} days` : `${h} h`);
const localTime = (s: string): Date | undefined => (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s) ? (fromZonedLocal(s, displayTimeZone()) ?? undefined) : undefined);
const idsOf = (body: Form, key: string) => {
  const raw = body[key];
  return (Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : []).filter((x): x is string => typeof x === 'string').map(uuidParam);
};

/** Specimens sent to referral labs: what to send, what was sent, and the list against turnaround (01 A-43, 09 W-27). */
@Controller('send-outs')
export class SendOutsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  async list(@Req() req: WebRequest, @Res() res: Response, @Query('tab') tab?: string, @Query('lab') lab?: string, @Query('state') state?: string, @Query('q') q?: string, @Query('accession') accession?: string, @Query('page') pg?: string): Promise<void> {
    if (tab === 'send') return this.renderSend(req, res, typeof accession === 'string' ? accession.trim().slice(0, 20) : '', {}, 200);
    const labId = typeof lab === 'string' && /^[0-9a-f-]{36}$/.test(lab) ? lab : '';
    const st = STATES.some(([s]) => s === state) ? (state as SendOutState) : '';
    const search = (typeof q === 'string' ? q : '').trim().slice(0, 40);
    const first = await sentTests(this.db, { labId, state: st, search, take: 0 });
    const { page: shown, skip } = pageWindow(pageParam(pg), first.total);
    const { rows, total, counts } = await sentTests(this.db, { labId, state: st, search, skip, take: PAGE_SIZE });
    const labs = await this.db.referralLab.findMany({ orderBy: { code: 'asc' } });
    page(req, res, 'send-outs', {
      title: 'Send-outs',
      tabs: tabs('sent'),
      waiting: (await sendOutWorklist(this.db)).length,
      labs: labs.map((l) => ({ id: l.id, code: l.code, name: l.name, selected: l.id === labId })),
      states: STATES.map(([value, label]) => ({ value, label, count: counts[value], selected: value === st })),
      q: search,
      overdue: counts.overdue,
      rows: rows.map((r) => ({
        ...r,
        dispatchedAt: formatTime(r.dispatchedAt),
        dueAt: formatTime(r.dueAt),
        resultedAt: formatTime(r.resultedAt),
        labReceivedAt: formatTime(r.labReceivedAt),
        tat: hours(r.tatHours),
        took: span(r.hours),
        stateLabel: STATES.find(([s]) => s === r.state)?.[1] ?? r.state,
        tone: r.state === 'overdue' || r.state === 'late' ? 'danger' : r.state === 'on-time' ? 'success' : r.state === 'cancelled' ? 'secondary' : 'warning',
      })),
      total,
      pager: pagerFor('/send-outs', { lab: labId || undefined, state: st || undefined, q: search || undefined }, shown, total),
    });
  }

  private async renderSend(req: WebRequest, res: Response, accession: string, failed: { specimenId?: string; issues?: string[]; fields?: Record<string, string>; ticked?: string[] }, status: number): Promise<void> {
    const cards = await sendOutWorklist(this.db, accession ? { accessionNo: accession } : {});
    const labs = await this.db.referralLab.findMany({ where: { active: true }, orderBy: { code: 'asc' }, include: { tests: { where: { active: true } } } });
    const now = zonedLocal(new Date(), displayTimeZone());
    const view = (c: SendCard) => {
      const mine = failed.specimenId === c.specimenId;
      const f = mine ? (failed.fields ?? {}) : {};
      // The lab picked by default: the one that does most of these tests, quickest first.
      const score = new Map<string, number>();
      for (const t of c.tests) for (const l of t.labs) score.set(l.labId, (score.get(l.labId) ?? 0) + 1);
      const best = f['labId'] || [...score.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
      return {
        ...c,
        stat: c.priority === 'stat',
        received: formatTime(c.receivedAt),
        issues: mine ? (failed.issues ?? []) : [],
        dispatchRef: f['dispatchRef'] ?? '',
        dispatchedAt: f['dispatchedAt'] || now,
        labs: labs.map((l) => ({ id: l.id, code: l.code, name: l.name, selected: l.id === best, does: c.tests.filter((t) => l.tests.some((x) => x.localTestCode === t.code)).map((t) => t.code).join(' ') })),
        tests: c.tests.map((t) => ({ ...t, checked: mine ? (failed.ticked ?? []).includes(t.orderedTestId) : t.labs.some((l) => l.labId === best), where: t.labs.map((l) => `${l.code} ${hours(l.tatHours)}`).join(', ') })),
      };
    };
    res.status(status);
    page(req, res, 'send-outs-send', {
      title: 'Send-outs',
      tabs: tabs('send'),
      accession,
      anyLab: labs.length > 0,
      cards: cards.map(view),
      issues: failed.issues && !cards.some((c) => c.specimenId === failed.specimenId) ? failed.issues : [],
    });
  }

  @Post()
  @Roles('technologist', 'approver')
  async send(@Req() req: WebRequest, @Res() res: Response, @Body() body: Form): Promise<void> {
    const fields = { labId: str(body, 'labId'), dispatchRef: str(body, 'dispatchRef'), dispatchedAt: str(body, 'dispatchedAt') };
    const specimenId = uuidParam(str(body, 'specimenId'));
    const ticked = idsOf(body, 'testIds');
    const at = localTime(fields.dispatchedAt);
    try {
      const id = await createSendOut(this.db, req.user!.username, { specimenId, labId: fields.labId ? uuidParam(fields.labId) : '', orderedTestIds: ticked, dispatchRef: fields.dispatchRef, ...(at ? { dispatchedAt: at } : {}) });
      res.redirect(303, `/send-outs/${id}?notice=send-out-sent`);
    } catch (e) {
      if (e instanceof InvalidInput) return this.renderSend(req, res, str(body, 'accession'), { specimenId, issues: e.issues, fields, ticked }, 422);
      throw e;
    }
  }

  @Get(':id')
  async show(@Req() req: WebRequest, @Res() res: Response, @Param('id') id: string): Promise<void> {
    await this.renderOne(req, res, uuidParam(id), {}, 200);
  }

  private async renderOne(req: WebRequest, res: Response, id: string, failed: { form?: string; issues?: string[]; values?: Map<string, string>; fields?: Record<string, string> }, status: number): Promise<void> {
    const s = await this.db.sendOut.findUnique({
      where: { id },
      include: {
        lab: true,
        specimen: { include: { order: { include: { patient: true } } } },
        tests: { include: { orderedTest: { include: { result: { include: { versions: true } } } } } },
        documents: { select: { id: true, kind: true, fileName: true, contentType: true, size: true, note: true, uploadedBy: true, uploadedAt: true }, orderBy: { uploadedAt: 'asc' } },
      },
    });
    if (!s) throw new NotFoundException();
    const p = s.specimen.order.patient;
    const f = failed.fields ?? {};
    const tests = await Promise.all(
      s.tests.map(async (x) => {
        const t = x.orderedTest;
        const code = t.localTestCode ?? t.hmisTestCode;
        const def = t.localTestCode ? await activeEntry(this.db, t.localTestCode) : null;
        const r = t.result;
        const v = r?.versions.find((y) => y.versionNo === r.selectedVersionNo);
        return {
          id: t.id,
          code,
          name: def?.name ?? code,
          unit: def?.unit ?? '',
          choice: def?.resultType === 'ORDINAL' || def?.resultType === 'NOMINAL',
          answers: (def?.answers ?? []).map((a) => ({ code: a.code, display: a.display, selected: (failed.values?.get(t.id) ?? '') === a.code })),
          value: failed.values?.get(t.id) ?? '',
          active: x.active,
          tat: hours(x.tatHours),
          dueAt: formatTime(new Date(s.dispatchedAt.getTime() + x.tatHours * 3_600_000)),
          result: r ? { id: r.id, status: r.status, value: v ? formatValue(v.value as unknown as Parameters<typeof formatValue>[0]) : '', units: v?.units ?? '' } : null,
        };
      }),
    );
    const open = s.status === 'sent' || s.status === 'received';
    res.status(status);
    page(req, res, 'send-out', {
      title: `Send-out ${s.specimen.accessionNo} to ${s.lab.code}`,
      s: {
        id: s.id,
        status: s.status,
        open,
        lab: { id: s.lab.id, code: s.lab.code, name: s.lab.name, phone: s.lab.phone ?? '', email: s.lab.email ?? '' },
        accessionNo: s.specimen.accessionNo,
        specimenId: s.specimenId,
        orderId: s.specimen.orderId,
        hmisOrderId: s.specimen.order.hmisOrderId,
        patient: { id: p.id, mrn: p.mrn, name: [p.familyName?.toUpperCase(), p.givenName].filter(Boolean).join(', ') },
        dispatchedAt: formatTime(s.dispatchedAt),
        dispatchedBy: s.dispatchedBy,
        dispatchRef: s.dispatchRef ?? '',
        dueAt: formatTime(s.dueAt),
        overdue: open && s.dueAt < new Date(),
        labReceivedAt: formatTime(s.labReceivedAt),
        labReceivedBy: s.labReceivedBy ?? '',
        labRef: s.labRef ?? '',
        resultedAt: formatTime(s.resultedAt),
        cancelled: s.cancelledAt ? { at: formatTime(s.cancelledAt), by: s.cancelledBy ?? '', reason: s.cancelReason ?? '' } : null,
      },
      tests,
      waiting: tests.filter((t) => t.active && !t.result),
      documents: s.documents.map((d) => ({ ...d, kindLabel: KIND_LABEL[d.kind] ?? d.kind, size: d.size >= 1048576 ? `${(d.size / 1048576).toFixed(1)} MB` : `${Math.ceil(d.size / 1024)} KB`, uploadedAt: formatTime(d.uploadedAt) })),
      kinds: Object.entries(KIND_LABEL).map(([value, label]) => ({ value, label, selected: value === (f['kind'] || (s.labReceivedAt ? 'result-report' : 'receiving-report')) })),
      now: zonedLocal(new Date(), displayTimeZone()),
      f,
      issues: failed.issues ?? [],
      form: failed.form ?? '',
      canWork: (req.user?.roles ?? []).some((r) => r === 'technologist' || r === 'approver'),
    });
  }

  @Post(':id/received')
  @Roles('technologist', 'approver')
  async received(@Req() req: WebRequest, @Res() res: Response, @Param('id') id: string, @Body() body: Form): Promise<void> {
    const sid = uuidParam(id);
    const fields = { labRef: str(body, 'labRef'), receivedAt: str(body, 'receivedAt') };
    const at = localTime(fields.receivedAt);
    try {
      await recordReferralReceipt(this.db, req.user!.username, sid, { labRef: fields.labRef, ...(at ? { receivedAt: at } : {}) });
    } catch (e) {
      if (e instanceof InvalidInput) return this.renderOne(req, res, sid, { form: 'received', issues: e.issues, fields }, 422);
      throw e;
    }
    res.redirect(303, `/send-outs/${sid}?notice=send-out-received`);
  }

  @Post(':id/documents')
  @Roles('technologist', 'approver')
  async upload(@Req() req: WebRequest, @Res() res: Response, @Param('id') id: string, @Body() body: Form): Promise<void> {
    const sid = uuidParam(id);
    const r = req as unknown as UploadRequest;
    const fields = { kind: str(body, 'kind'), note: str(body, 'note') };
    if (r.uploadIssue || !r.file) return this.renderOne(req, res, sid, { form: 'document', issues: [r.uploadIssue ?? 'Choose a file to upload.'], fields }, 422);
    try {
      await addSendOutDocument(this.db, req.user!.username, sid, { kind: fields.kind, note: fields.note, fileName: r.file.originalname, bytes: r.file.buffer });
    } catch (e) {
      if (e instanceof InvalidInput) return this.renderOne(req, res, sid, { form: 'document', issues: e.issues, fields }, 422);
      throw e;
    }
    res.redirect(303, `/send-outs/${sid}?notice=send-out-document`);
  }

  /** Always a download: the file is the referral lab's, not a page of this site. */
  @Get(':id/documents/:docId')
  async download(@Res() res: Response, @Param('id') id: string, @Param('docId') docId: string): Promise<void> {
    const d = await sendOutDocument(this.db, uuidParam(id), uuidParam(docId));
    if (!d) throw new NotFoundException();
    res.set('Content-Disposition', `attachment; filename="${d.fileName}"`).type(d.contentType).send(d.bytes);
  }

  @Post(':id/results')
  @Roles('technologist', 'approver')
  async results(@Req() req: WebRequest, @Res() res: Response, @Param('id') id: string, @Body() body: Form): Promise<void> {
    const sid = uuidParam(id);
    const values = Object.keys(body ?? {})
      .filter((k) => k.startsWith('value-'))
      .map((k) => ({ orderedTestId: uuidParam(k.slice('value-'.length)), value: str(body, k) }));
    const fields = { reportRef: str(body, 'reportRef') };
    try {
      await enterSendOutResults(this.db, req.user!.username, sid, { ...fields, values });
    } catch (e) {
      if (e instanceof InvalidInput) return this.renderOne(req, res, sid, { form: 'results', issues: e.issues, values: new Map(values.map((v) => [v.orderedTestId, v.value])), fields }, 422);
      throw e;
    }
    res.redirect(303, `/send-outs/${sid}?notice=send-out-results`);
  }

  @Post(':id/cancel')
  @Roles('technologist', 'approver')
  async cancel(@Req() req: WebRequest, @Res() res: Response, @Param('id') id: string, @Body() body: Form): Promise<void> {
    const sid = uuidParam(id);
    const fields = { reason: str(body, 'reason') };
    try {
      await cancelSendOut(this.db, req.user!.username, sid, fields.reason);
    } catch (e) {
      if (e instanceof InvalidInput) return this.renderOne(req, res, sid, { form: 'cancel', issues: e.issues, fields }, 422);
      throw e;
    }
    res.redirect(303, `/send-outs/${sid}?notice=send-out-cancelled`);
  }
}

function tabs(active: 'sent' | 'send') {
  return [
    { href: '/send-outs', label: 'Sent tests', active: active === 'sent' },
    { href: '/send-outs?tab=send', label: 'To send', active: active === 'send' },
  ];
}

import { Body, Controller, Get, Inject, NotFoundException, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { ResultValue } from '@lis/contracts';
import type { Db } from '@lis/db';
import { accessionSpecimen, InvalidInput, matchAddedTest, receiveSpecimen, recordLabelPrint, rejectSpecimen, REJECTION_REASONS, type RejectionReason } from '@lis/lab';
import bwipjs from 'bwip-js';
import type { Response } from 'express';
import { page, requireStepUp, str, uuidParam, type Form } from './controllers.js';
import { fromZonedLocal, zonedLocal } from '@lis/domain';
import { displayTimeZone, formatTime, formatValue, STATUS_LABELS } from './format.js';
import { Roles, type WebRequest } from './security.js';
import { DB } from './tokens.js';

const FILTERS = { awaiting: 'Awaiting collection', collected: 'Collected', all: 'All' } as const;
type Filter = keyof typeof FILTERS;

function patientLine(p: { id: string; familyName: string | null; givenName: string | null; mrn: string; sex: string | null; birthDate: Date | null }) {
  const name = [p.familyName?.toUpperCase(), p.givenName].filter(Boolean).join(', ') || '(no name)';
  return { id: p.id, name, mrn: p.mrn, sex: p.sex ?? '', birthDate: p.birthDate ? p.birthDate.toISOString().slice(0, 10) : '' };
}

/**
 * Code 128 barcode as inline SVG, drawn on the server so the page needs no
 * script. ASSUMPTION A-14: Code 128 of the accession number until the
 * hospital's label specification (B-8) says otherwise.
 */
export function barcodeSvg(text: string): string {
  return bwipjs.toSVG({ bcid: 'code128', text, height: 10, includetext: false, paddingwidth: 2, paddingheight: 1 });
}

@Controller()
export class OrdersController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get('orders')
  async list(@Req() req: WebRequest, @Res() res: Response, @Query('filter') f?: string, @Query('q') q?: string, @Query('stat') stat?: string): Promise<void> {
    const filter: Filter = f && f in FILTERS ? (f as Filter) : 'awaiting';
    const search = (q ?? '').trim().slice(0, 60);
    const where = {
      AND: [
        filter === 'awaiting' ? { status: 'active', tests: { some: { specimenId: null, status: 'active' } } } : {},
        filter === 'collected' ? { specimens: { some: {} } } : {},
        stat === '1' ? { priority: 'stat' } : {},
        search
          ? {
              OR: [
                { hmisOrderId: { contains: search, mode: 'insensitive' as const } },
                { patient: { mrn: { contains: search, mode: 'insensitive' as const } } },
                { patient: { familyName: { contains: search, mode: 'insensitive' as const } } },
                { specimens: { some: { accessionNo: search.toUpperCase() } } },
              ],
            }
          : {},
      ],
    };
    const orders = await this.db.labOrder.findMany({
      where,
      // STAT first, then oldest first: what the collector should do next.
      orderBy: [{ priority: 'desc' }, { orderedAt: 'asc' }],
      take: 200,
      include: { patient: true, tests: true },
    });
    // A single exact accession hit goes straight to that order (scanner at the bench).
    if (search && orders.length === 1 && /^L\d{11}$/i.test(search)) return res.redirect(303, `/orders/${orders[0]!.id}`);
    page(req, res, 'orders', {
      title: 'Orders',
      q: search,
      stat: stat === '1',
      filter,
      filters: Object.entries(FILTERS).map(([value, label]) => ({ value, label, active: value === filter })),
      rows: orders.map((o) => ({
        id: o.id,
        hmisOrderId: o.hmisOrderId,
        stat: o.priority === 'stat',
        priority: o.priority,
        patient: patientLine(o.patient),
        tests: o.tests.map((t) => t.localTestCode ?? `${t.hmisTestCode}?`).join(' '),
        pending: o.tests.filter((t) => !t.specimenId && t.status === 'active').length,
        orderedAt: formatTime(o.orderedAt),
        cancelled: o.status === 'cancelled',
        downtime: o.source === 'MANUAL_DOWNTIME',
        reconciled: o.status === 'reconciled',
      })),
    });
  }

  @Get('orders/:id')
  async detail(@Req() req: WebRequest, @Res() res: Response, @Param('id') id: string): Promise<void> {
    const o = await this.db.labOrder.findUnique({
      where: { id: uuidParam(id) },
      include: { patient: true, tests: { orderBy: { hmisLineId: 'asc' }, include: { result: true } }, specimens: { orderBy: { createdAt: 'asc' }, include: { tests: true } } },
    });
    if (!o) throw new NotFoundException();
    // A test the lab added (A-34) is never collected: it came with its specimen.
    const pending = o.tests.filter((t) => !t.specimenId && t.source !== 'LAB_ADDED');
    const waitingAdded = o.tests.filter((t) => t.source === 'LAB_ADDED' && t.status === 'active');
    const free = (t: (typeof o.tests)[number]) => t.source === 'HMIS' && t.status === 'active' && !t.specimenId && !t.result;
    const lineOf = new Map(o.tests.map((t) => [t.id, t.hmisLineId]));
    const groups = new Map<string, typeof pending>();
    for (const t of pending) {
      const key = t.specimenType ?? 'Specimen type not given by the HMIS';
      groups.set(key, [...(groups.get(key) ?? []), t]);
    }
    page(req, res, 'order', {
      title: `Order ${o.hmisOrderId}`,
      o: { id: o.id, downtime: o.source === 'MANUAL_DOWNTIME', reconciled: o.status === 'reconciled', provisional: o.patient.provisional, hmisOrderId: o.hmisOrderId, priority: o.priority, stat: o.priority === 'stat', status: o.status, encounter: o.hmisEncounterId ?? '', location: o.location ?? '', clinician: o.orderingClinician ?? '', orderedAt: formatTime(o.orderedAt) },
      patient: patientLine(o.patient),
      groups: [...groups].map(([type, tests]) => ({
        type,
        tests: tests.map((t) => ({
          id: t.id, code: t.localTestCode ?? t.hmisTestCode, unmapped: !t.localTestCode, cancelled: t.status === 'cancelled',
          matchesAdded: free(t) && waitingAdded.some((a) => a.localTestCode === t.localTestCode),
        })),
        collectable: tests.some((t) => t.status === 'active'),
      })),
      specimens: o.specimens.map((s) => ({
        id: s.id,
        accessionNo: s.accessionNo,
        status: s.status,
        collected: s.status === 'collected',
        open: s.status === 'collected' || s.status === 'received',
        collectedAt: formatTime(s.collectedAt),
        receivedAt: formatTime(s.receivedAt),
        prints: s.labelPrints,
        tests: s.tests.map((t) => t.localTestCode ?? t.hmisTestCode).join(' '),
        rejection: s.rejectionReason ?? '',
      })),
      added: o.tests.filter((t) => t.source === 'LAB_ADDED').map((t) => ({
        id: t.id,
        code: t.localTestCode ?? t.hmisTestCode,
        requestedBy: t.requestedBy ?? '',
        addedBy: t.addedBy ?? '',
        confirmedBy: t.addedConfirmedBy ?? '',
        reason: t.addedReason ?? '',
        at: formatTime(t.addedAt),
        waiting: t.status === 'active',
        matched: t.matchedToId ? { line: lineOf.get(t.matchedToId) ?? '', by: t.matchedBy ?? '', at: formatTime(t.matchedAt) } : null,
        resultId: t.result?.id ?? '',
        candidates: t.status === 'active' ? o.tests.filter((h) => free(h) && h.localTestCode === t.localTestCode).map((h) => ({ id: h.id, line: h.hmisLineId, code: h.hmisTestCode })) : [],
      })),
      reasons: Object.entries(REJECTION_REASONS).map(([value, label]) => ({ value, label })),
      now: zonedLocal(new Date(), displayTimeZone()),
    });
  }

  /** Collect the chosen tests into one specimen, then go straight to its label. */
  /** Move a test the lab added onto the clinician's HMIS order line once it has arrived (A-34). */
  @Post('orders/:id/match-added')
  @Roles('technologist', 'approver')
  async matchAdded(@Req() req: WebRequest, @Res() res: Response, @Param('id') id: string, @Body() body: Form): Promise<void> {
    await requireStepUp(this.db, req, str(body, 'password'));
    await matchAddedTest(this.db, uuidParam(str(body, 'addedTestId')), uuidParam(str(body, 'hmisTestId')), req.user!.username);
    res.redirect(303, `/orders/${uuidParam(id)}?notice=added-test-matched`);
  }

  @Post('orders/:id/collect')
  @Roles('operator', 'technologist', 'approver')
  async collect(@Req() req: WebRequest, @Res() res: Response, @Param('id') id: string, @Body() body: Form): Promise<void> {
    const raw = body['testIds'];
    const ids = (Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : []).filter((x): x is string => typeof x === 'string').map(uuidParam);
    const at = str(body, 'collectedAt');
    // Typed on the lab's clock (A-24).
    const collectedAt = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(at) ? (fromZonedLocal(at, displayTimeZone()) ?? undefined) : undefined;
    if (collectedAt && collectedAt.getTime() > Date.now() + 5 * 60_000) throw new InvalidInput(['Collection time is in the future.']);
    const r = await accessionSpecimen(this.db, { orderId: uuidParam(id), orderedTestIds: ids, user: req.user!.username, ...(collectedAt ? { collectedAt } : {}) });
    res.redirect(303, `/specimens/${r.specimenId}/label`);
  }

  @Get('specimens/:id/label')
  async label(@Req() req: WebRequest, @Res() res: Response, @Param('id') id: string): Promise<void> {
    const s = await this.db.specimen.findUnique({ where: { id: uuidParam(id) }, include: { order: { include: { patient: true } }, tests: true } });
    if (!s) throw new NotFoundException();
    const p = patientLine(s.order.patient);
    page(req, res, 'label', {
      title: `Label ${s.accessionNo}`,
      s: { id: s.id, accessionNo: s.accessionNo, prints: s.labelPrints, type: s.tests[0]?.specimenType ?? '', tests: s.tests.map((t) => t.localTestCode ?? t.hmisTestCode).join(' '), orderId: s.orderId },
      patient: p,
      stat: s.order.priority === 'stat',
      barcode: barcodeSvg(s.barcode),
    });
  }

  @Post('specimens/:id/reprint')
  @Roles('operator', 'technologist', 'approver')
  async reprint(@Req() req: WebRequest, @Res() res: Response, @Param('id') id: string): Promise<void> {
    await recordLabelPrint(this.db, uuidParam(id), req.user!.username);
    res.redirect(303, `/specimens/${id}/label?notice=reprinted`);
  }

  @Post('specimens/:id/receive')
  @Roles('operator', 'technologist', 'approver')
  async receive(@Req() req: WebRequest, @Res() res: Response, @Param('id') id: string): Promise<void> {
    await receiveSpecimen(this.db, uuidParam(id), req.user!.username);
    const s = await this.db.specimen.findUniqueOrThrow({ where: { id } });
    res.redirect(303, `/orders/${s.orderId}?notice=received`);
  }

  @Post('specimens/:id/reject')
  @Roles('technologist', 'approver')
  async reject(@Req() req: WebRequest, @Res() res: Response, @Param('id') id: string, @Body() body: Form): Promise<void> {
    await rejectSpecimen(this.db, uuidParam(id), req.user!.username, { code: str(body, 'code') as RejectionReason, text: str(body, 'text'), recollect: str(body, 'recollect') === 'yes' });
    const s = await this.db.specimen.findUniqueOrThrow({ where: { id } });
    res.redirect(303, `/orders/${s.orderId}?notice=rejected`);
  }

  /** W-3: everything that happened to one specimen, from the audit trail and the results. */
  @Get('specimens/:id')
  async timeline(@Req() req: WebRequest, @Res() res: Response, @Param('id') id: string): Promise<void> {
    const s = await this.db.specimen.findUnique({
      where: { id: uuidParam(id) },
      include: { order: { include: { patient: true } }, tests: { include: { result: { include: { versions: true, events: true } } } } },
    });
    if (!s) throw new NotFoundException();
    const audit = await this.db.auditEvent.findMany({ where: { entityType: 'specimen', entityId: s.id }, orderBy: { seq: 'asc' } });
    const orderAudit = await this.db.auditEvent.findFirst({ where: { entityType: 'lab_order', entityId: s.orderId, action: 'order.received' } });
    type Entry = { at: Date; text: string; href?: string };
    const entries: Entry[] = [];
    if (orderAudit) entries.push({ at: orderAudit.at, text: `Order received from the HMIS (${s.order.hmisOrderId})` });
    const words: Record<string, string> = { 'specimen.collected': 'Collected, label printed', 'specimen.label-reprint': 'Label reprinted', 'specimen.received': 'Received in the lab', 'specimen.rejected': 'Rejected', 'specimen.result-linked': 'Unmatched result linked', 'specimen.reconciled': 'Downtime order reconciled' };
    for (const a of audit) entries.push({ at: a.at, text: `${words[a.action] ?? a.action} by ${a.actor}${a.reason ? `: ${a.reason}` : ''}` });
    for (const t of s.tests) {
      const r = t.result;
      if (!r) continue;
      for (const v of r.versions) entries.push({ at: v.createdAt, text: `${t.localTestCode ?? t.hmisTestCode} ${v.kind} result ${formatValue(v.value as unknown as ResultValue)} ${v.units ?? ''} from ${v.createdBy}`, href: `/results/${r.id}` });
      for (const e of r.events) entries.push({ at: e.at, text: `${t.localTestCode ?? t.hmisTestCode} ${e.kind} by ${e.actor}`, href: `/results/${r.id}` });
    }
    entries.sort((a, b) => a.at.getTime() - b.at.getTime());
    page(req, res, 'specimen', {
      title: `Specimen ${s.accessionNo}`,
      s: { accessionNo: s.accessionNo, status: s.status, orderId: s.orderId, hmisOrderId: s.order.hmisOrderId, rejection: s.rejectionReason ?? '' },
      patient: patientLine(s.order.patient),
      results: s.tests.map((t) => ({ test: t.localTestCode ?? t.hmisTestCode, status: t.result ? (STATUS_LABELS[t.result.status] ?? t.result.status) : 'No result yet', href: t.result ? `/results/${t.result.id}` : '' })),
      entries: entries.map((e) => ({ at: formatTime(e.at), text: e.text, href: e.href ?? '' })),
    });
  }
}

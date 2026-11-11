import { Body, Controller, Get, Inject, NotFoundException, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Db } from '@lis/db';
import { confirmMerge, confirmUnmerge, InvalidInput, patientHistory, patientOrders, patientsWithPendingResults, proposeMerge, proposeUnmerge, withdrawMerge, withdrawUnmerge } from '@lis/lab';
import type { Response } from 'express';
import { page, requireStepUp, str, uuidParam, type Form } from './controllers.js';
import { cumulative } from './cumulative.js';
import { formatTime } from './format.js';
import { PAGE_SIZE, pageParam, pagerFor, pageWindow } from './paging.js';
import { Roles, type WebRequest } from './security.js';
import { DB } from './tokens.js';

const name = (p: { familyName: string | null; givenName: string | null }) => [p.familyName?.toUpperCase(), p.givenName].filter(Boolean).join(', ') || '(no name)';
type PatientRow = { id: string; mrn: string; familyName: string | null; givenName: string | null; sex: string | null; birthDate: Date | null };
const line = (p: PatientRow) => ({ id: p.id, mrn: p.mrn, name: name(p), sex: p.sex ?? '', birthDate: p.birthDate?.toISOString().slice(0, 10) ?? '' });

/** Patient search, the cumulative result history (09 W-13), and recording a merge (A-35). */
@Controller('patients')
export class PatientsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Patients with results still pending by default; "All patients" lists everyone by name. A search narrows either. */
  @Get()
  async search(@Req() req: WebRequest, @Res() res: Response, @Query('q') q?: string, @Query('show') show?: string, @Query('page') pg?: string): Promise<void> {
    const search = (typeof q === 'string' ? q : '').trim().slice(0, 60);
    const all = show === 'all';
    const term = search.length >= 2 ? search : '';
    if (term) {
      const exact = await this.db.patient.findFirst({ where: { mrn: { equals: term, mode: 'insensitive' } } });
      if (exact) return res.redirect(303, `/patients/${exact.id}`);
    }
    let rows: Record<string, unknown>[];
    let total: number;
    let shown: number;
    let capped = false;
    if (all) {
      const where = term ? { OR: [{ mrn: { startsWith: term, mode: 'insensitive' as const } }, { familyName: { startsWith: term, mode: 'insensitive' as const } }, { givenName: { startsWith: term, mode: 'insensitive' as const } }] } : {};
      total = await this.db.patient.count({ where });
      const w = pageWindow(pageParam(pg), total);
      shown = w.page;
      const patients = await this.db.patient.findMany({ where, orderBy: [{ familyName: 'asc' }, { givenName: 'asc' }, { mrn: 'asc' }], skip: w.skip, take: PAGE_SIZE });
      rows = patients.map((p) => ({ ...line(p), provisional: p.provisional, merged: !!p.mergedIntoId }));
    } else {
      const pending = await patientsWithPendingResults(this.db, { search: term });
      capped = pending.capped;
      total = pending.rows.length;
      const w = pageWindow(pageParam(pg), total);
      shown = w.page;
      const slice = pending.rows.slice(w.skip, w.skip + PAGE_SIZE);
      const people = new Map((await this.db.patient.findMany({ where: { id: { in: slice.map((r) => r.patientId) } } })).map((p) => [p.id, p]));
      rows = slice.flatMap((r) => {
        const p = people.get(r.patientId);
        return p ? [{ ...line(p), provisional: p.provisional, merged: !!p.mergedIntoId, pendingTests: r.pendingTests, orders: r.orders, stat: r.priority === 'stat', urgent: r.priority === 'urgent', waitingSince: formatTime(r.oldestOrderedAt) }] : [];
      });
    }
    page(req, res, 'patients', {
      title: 'Patients',
      q: search,
      all,
      tabs: [
        { href: term ? `/patients?q=${encodeURIComponent(term)}` : '/patients', label: 'Pending results', active: !all },
        { href: `/patients?show=all${term ? `&q=${encodeURIComponent(term)}` : ''}`, label: 'All patients', active: all },
      ],
      rows,
      total,
      capped,
      pager: pagerFor('/patients', { show: all ? 'all' : undefined, q: term || undefined }, shown, total),
    });
  }

  @Get(':id')
  async history(@Req() req: WebRequest, @Res() res: Response, @Param('id') id: string): Promise<void> {
    await this.render(req, res, uuidParam(id), {}, [], 200);
  }

  private async render(req: WebRequest, res: Response, id: string, v: Record<string, string>, issues: string[], status: number, uv: Record<string, string> = {}, undoIssues: string[] = []): Promise<void> {
    const p = await this.db.patient.findUnique({ where: { id } });
    if (!p) throw new NotFoundException();
    const [results, into, merged, waiting, undone] = await Promise.all([
      patientHistory(this.db, p.id),
      p.mergedIntoId ? this.db.patient.findUnique({ where: { id: p.mergedIntoId } }) : null,
      this.db.patientMerge.findMany({ where: { intoPatientId: p.id, status: 'CONFIRMED' }, include: { from: true }, orderBy: { decidedAt: 'asc' } }),
      this.db.patientMerge.findFirst({ where: { fromPatientId: p.id, status: 'PROPOSED' }, include: { into: true } }),
      this.db.patientMerge.findMany({ where: { OR: [{ fromPatientId: p.id }, { intoPatientId: p.id }], status: 'UNDONE' }, include: { from: true, into: true }, orderBy: { undoneAt: 'asc' } }),
    ]);
    const mergeRecord = p.mergedIntoId && !p.provisional ? await this.db.patientMerge.findFirst({ where: { fromPatientId: p.id, status: 'CONFIRMED' } }) : null;
    const c = cumulative(results);
    const orders = (await patientOrders(this.db, [p.id, ...merged.map((m) => m.fromPatientId)])).map((o) => ({
      id: o.id,
      hmisOrderId: o.hmisOrderId,
      mrn: o.mrn,
      stat: o.priority === 'stat',
      priority: o.priority,
      location: o.location ?? '',
      orderedAt: formatTime(o.orderedAt),
      tests: o.tests,
      approved: o.approved,
      pending: o.pending,
      cancelled: o.status === 'cancelled',
      reconciled: o.status === 'reconciled',
      downtime: o.source === 'MANUAL_DOWNTIME',
      current: o.current,
      printable: o.approved > 0,
    }));
    const roles = req.user?.roles ?? [];
    res.status(status);
    page(req, res, 'patient', {
      title: `${name(p)} (${p.mrn})`,
      p: { id: p.id, name: name(p), mrn: p.mrn, sex: p.sex ?? '', birthDate: p.birthDate?.toISOString().slice(0, 10) ?? '', provisional: p.provisional, mergedInto: p.mergedIntoId ? `/patients/${p.mergedIntoId}` : '' },
      mergedAway: into && mergeRecord
        ? {
            id: mergeRecord.id, into: line(into), reference: mergeRecord.reference, by: `${mergeRecord.proposedBy} and ${mergeRecord.decidedBy ?? ''}`, at: formatTime(mergeRecord.decidedAt),
            undo: mergeRecord.undoProposedBy
              ? { by: mergeRecord.undoProposedBy, at: formatTime(mergeRecord.undoProposedAt), reference: mergeRecord.undoReference ?? '', reason: mergeRecord.undoReason ?? '', mine: mergeRecord.undoProposedBy === req.user?.username }
              : null,
          }
        : null,
      undone: undone.map((m) => ({ from: line(m.from), into: line(m.into), reference: m.undoReference ?? '', reason: m.undoReason ?? '', by: `${m.undoProposedBy ?? ''} and ${m.undoneBy ?? ''}`, at: formatTime(m.undoneAt) })),
      canUndo: roles.includes('admin') || roles.includes('approver'),
      u: uv,
      undoIssues,
      mergedIn: merged.map((m) => ({ ...line(m.from), reference: m.reference, at: formatTime(m.decidedAt) })),
      waiting: waiting
        ? {
            id: waiting.id, into: line(waiting.into), reference: waiting.reference, reason: waiting.reason, by: waiting.proposedBy, at: formatTime(waiting.proposedAt),
            mine: waiting.proposedBy === req.user?.username,
            // Shown side by side so the second person sees any difference before confirming.
            differs: [
              ...(name(p) !== name(waiting.into) ? ['name'] : []),
              ...((p.sex ?? '') !== (waiting.into.sex ?? '') ? ['sex'] : []),
              ...((p.birthDate?.getTime() ?? 0) !== (waiting.into.birthDate?.getTime() ?? 0) ? ['date of birth'] : []),
            ].join(', '),
          }
        : null,
      canMerge: (roles.includes('admin') || roles.includes('approver')) && !p.mergedIntoId && !p.provisional,
      v,
      issues,
      c,
      currentOrders: orders.filter((o) => o.current),
      pastOrders: orders.filter((o) => !o.current),
      count: results.length,
      capped: results.length >= 500,
    });
  }

  @Post(':id/merge')
  @Roles('admin', 'approver')
  async propose(@Req() req: WebRequest, @Res() res: Response, @Param('id') id: string, @Body() body: Form): Promise<void> {
    const pid = uuidParam(id);
    const v = { intoMrn: str(body, 'intoMrn'), reference: str(body, 'reference'), reason: str(body, 'reason') };
    try {
      await proposeMerge(this.db, req.user!.username, { fromPatientId: pid, ...v });
    } catch (e) {
      if (e instanceof InvalidInput) return this.render(req, res, pid, v, e.issues, 422);
      throw e;
    }
    res.redirect(303, `/patients/${pid}?notice=merge-proposed`);
  }

  /** Second person, with password re-entry. */
  @Post(':id/merge/:mergeId/confirm')
  @Roles('admin', 'approver')
  async confirm(@Req() req: WebRequest, @Res() res: Response, @Param('id') id: string, @Param('mergeId') mergeId: string, @Body() body: Form): Promise<void> {
    await requireStepUp(this.db, req, str(body, 'password'));
    await confirmMerge(this.db, req.user!.username, uuidParam(mergeId));
    res.redirect(303, `/patients/${uuidParam(id)}?notice=merge-confirmed`);
  }

  @Post(':id/merge/:mergeId/withdraw')
  @Roles('admin', 'approver')
  async withdraw(@Req() req: WebRequest, @Res() res: Response, @Param('id') id: string, @Param('mergeId') mergeId: string): Promise<void> {
    await withdrawMerge(this.db, req.user!.username, uuidParam(mergeId));
    res.redirect(303, `/patients/${uuidParam(id)}?notice=merge-withdrawn`);
  }

  /** Undoing a confirmed merge (A-39): first person, from the merged MRN's page. */
  @Post(':id/merge/:mergeId/undo')
  @Roles('admin', 'approver')
  async proposeUndo(@Req() req: WebRequest, @Res() res: Response, @Param('id') id: string, @Param('mergeId') mergeId: string, @Body() body: Form): Promise<void> {
    const pid = uuidParam(id);
    const uv = { reference: str(body, 'reference'), reason: str(body, 'reason') };
    try {
      await proposeUnmerge(this.db, req.user!.username, uuidParam(mergeId), uv);
    } catch (e) {
      if (e instanceof InvalidInput) return this.render(req, res, pid, {}, [], 422, uv, e.issues);
      throw e;
    }
    res.redirect(303, `/patients/${pid}?notice=unmerge-proposed`);
  }

  /** Second person, with password re-entry. */
  @Post(':id/merge/:mergeId/undo/confirm')
  @Roles('admin', 'approver')
  async confirmUndo(@Req() req: WebRequest, @Res() res: Response, @Param('id') id: string, @Param('mergeId') mergeId: string, @Body() body: Form): Promise<void> {
    await requireStepUp(this.db, req, str(body, 'password'));
    await confirmUnmerge(this.db, req.user!.username, uuidParam(mergeId));
    res.redirect(303, `/patients/${uuidParam(id)}?notice=unmerge-confirmed`);
  }

  @Post(':id/merge/:mergeId/undo/withdraw')
  @Roles('admin', 'approver')
  async withdrawUndo(@Req() req: WebRequest, @Res() res: Response, @Param('id') id: string, @Param('mergeId') mergeId: string): Promise<void> {
    await withdrawUnmerge(this.db, req.user!.username, uuidParam(mergeId));
    res.redirect(303, `/patients/${uuidParam(id)}?notice=unmerge-withdrawn`);
  }
}

import { Body, Controller, Get, Inject, NotFoundException, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Db } from '@lis/db';
import { confirmMerge, InvalidInput, patientHistory, proposeMerge, withdrawMerge } from '@lis/lab';
import type { Response } from 'express';
import { page, requireStepUp, str, uuidParam, type Form } from './controllers.js';
import { cumulative } from './cumulative.js';
import { formatTime } from './format.js';
import { Roles, type WebRequest } from './security.js';
import { DB } from './tokens.js';

const name = (p: { familyName: string | null; givenName: string | null }) => [p.familyName?.toUpperCase(), p.givenName].filter(Boolean).join(', ') || '(no name)';
type PatientRow = { id: string; mrn: string; familyName: string | null; givenName: string | null; sex: string | null; birthDate: Date | null };
const line = (p: PatientRow) => ({ id: p.id, mrn: p.mrn, name: name(p), sex: p.sex ?? '', birthDate: p.birthDate?.toISOString().slice(0, 10) ?? '' });

/** Patient search, the cumulative result history (09 W-13), and recording a merge (A-35). */
@Controller('patients')
export class PatientsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  async search(@Req() req: WebRequest, @Res() res: Response, @Query('q') q?: string): Promise<void> {
    const search = (typeof q === 'string' ? q : '').trim().slice(0, 60);
    const patients = search.length >= 2
      ? await this.db.patient.findMany({
          where: { OR: [{ mrn: { equals: search, mode: 'insensitive' } }, { mrn: { startsWith: search, mode: 'insensitive' } }, { familyName: { startsWith: search, mode: 'insensitive' } }] },
          orderBy: [{ familyName: 'asc' }, { givenName: 'asc' }],
          take: 100,
        })
      : [];
    if (patients.length === 1 && patients[0]!.mrn.toLowerCase() === search.toLowerCase()) return res.redirect(303, `/patients/${patients[0]!.id}`);
    page(req, res, 'patients', {
      title: 'Patients',
      q: search,
      searched: search.length >= 2,
      rows: patients.map((p) => ({ id: p.id, name: name(p), mrn: p.mrn, sex: p.sex ?? '', birthDate: p.birthDate?.toISOString().slice(0, 10) ?? '', provisional: p.provisional, merged: !!p.mergedIntoId })),
    });
  }

  @Get(':id')
  async history(@Req() req: WebRequest, @Res() res: Response, @Param('id') id: string): Promise<void> {
    await this.render(req, res, uuidParam(id), {}, [], 200);
  }

  private async render(req: WebRequest, res: Response, id: string, v: Record<string, string>, issues: string[], status: number): Promise<void> {
    const p = await this.db.patient.findUnique({ where: { id } });
    if (!p) throw new NotFoundException();
    const [results, into, merged, waiting] = await Promise.all([
      patientHistory(this.db, p.id),
      p.mergedIntoId ? this.db.patient.findUnique({ where: { id: p.mergedIntoId } }) : null,
      this.db.patientMerge.findMany({ where: { intoPatientId: p.id, status: 'CONFIRMED' }, include: { from: true }, orderBy: { decidedAt: 'asc' } }),
      this.db.patientMerge.findFirst({ where: { fromPatientId: p.id, status: 'PROPOSED' }, include: { into: true } }),
    ]);
    const mergeRecord = p.mergedIntoId && !p.provisional ? await this.db.patientMerge.findFirst({ where: { fromPatientId: p.id, status: 'CONFIRMED' } }) : null;
    const c = cumulative(results);
    const roles = req.user?.roles ?? [];
    res.status(status);
    page(req, res, 'patient', {
      title: `${name(p)} (${p.mrn})`,
      p: { id: p.id, name: name(p), mrn: p.mrn, sex: p.sex ?? '', birthDate: p.birthDate?.toISOString().slice(0, 10) ?? '', provisional: p.provisional, mergedInto: p.mergedIntoId ? `/patients/${p.mergedIntoId}` : '' },
      mergedAway: into && mergeRecord ? { into: line(into), reference: mergeRecord.reference, by: `${mergeRecord.proposedBy} and ${mergeRecord.decidedBy ?? ''}`, at: formatTime(mergeRecord.decidedAt) } : null,
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
}

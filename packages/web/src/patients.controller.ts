import { Controller, Get, Inject, NotFoundException, Param, Query, Req, Res } from '@nestjs/common';
import type { Db } from '@lis/db';
import { patientHistory } from '@lis/lab';
import type { Response } from 'express';
import { page, uuidParam } from './controllers.js';
import { cumulative } from './cumulative.js';
import type { WebRequest } from './security.js';
import { DB } from './tokens.js';

const name = (p: { familyName: string | null; givenName: string | null }) => [p.familyName?.toUpperCase(), p.givenName].filter(Boolean).join(', ') || '(no name)';

/** Patient search and the cumulative result history (09 W-13). */
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
    const p = await this.db.patient.findUnique({ where: { id: uuidParam(id) } });
    if (!p) throw new NotFoundException();
    const results = await patientHistory(this.db, p.id);
    const c = cumulative(results);
    page(req, res, 'patient', {
      title: `${name(p)} (${p.mrn})`,
      p: { name: name(p), mrn: p.mrn, sex: p.sex ?? '', birthDate: p.birthDate?.toISOString().slice(0, 10) ?? '', provisional: p.provisional, mergedInto: p.mergedIntoId ? `/patients/${p.mergedIntoId}` : '' },
      c,
      count: results.length,
      capped: results.length >= 500,
    });
  }
}

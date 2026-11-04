import { Body, Controller, ForbiddenException, Get, Inject, NotFoundException, Param, Post, Req, Res } from '@nestjs/common';
import type { Db } from '@lis/db';
import { DOWNTIME, downtimeTestCatalogue, InvalidInput, reconcileDowntimeOrder, reconciliationCandidates, registerDowntimeOrder } from '@lis/lab';
import type { Response } from 'express';
import { confirmPassword } from './auth.js';
import { page, str, uuidParam, type Form } from './controllers.js';
import { formatTime } from './format.js';
import { Roles, type WebRequest } from './security.js';
import { DB } from './tokens.js';

const name = (p: { familyName: string | null; givenName: string | null }) => [p.familyName?.toUpperCase(), p.givenName].filter(Boolean).join(', ') || '(no name)';
const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : '');

function list(body: Form, key: string): string[] {
  const raw = body[key];
  return (Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : []).filter((x): x is string => typeof x === 'string');
}

/** W-2 downtime registration and reconciliation (06 §5.2). */
@Controller('downtime')
export class DowntimeController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  async index(@Req() req: WebRequest, @Res() res: Response): Promise<void> {
    const orders = await this.db.labOrder.findMany({ where: { source: DOWNTIME }, orderBy: [{ reconciledAt: { sort: 'desc', nulls: 'first' } }, { orderedAt: 'desc' }], take: 200, include: { patient: true, tests: true } });
    page(req, res, 'downtime', {
      title: 'Downtime orders',
      rows: orders.map((o) => ({
        id: o.id,
        downtimeId: o.hmisOrderId,
        patient: name(o.patient),
        birthDate: day(o.patient.birthDate),
        tests: o.tests.map((t) => t.localTestCode).join(' '),
        at: formatTime(o.orderedAt),
        reconciled: Boolean(o.reconciledAt),
        reconciledBy: o.reconciledBy ?? '',
      })),
    });
  }

  @Get('new')
  @Roles('operator', 'technologist', 'approver')
  async form(@Req() req: WebRequest, @Res() res: Response): Promise<void> {
    await this.renderForm(req, res, {}, []);
  }

  private async renderForm(req: WebRequest, res: Response, values: Record<string, unknown>, issues: string[], status = 200): Promise<void> {
    const chosen = new Set((values['tests'] as string[] | undefined) ?? []);
    const catalogue = await downtimeTestCatalogue(this.db);
    res.status(status);
    page(req, res, 'downtime-new', { title: 'Downtime registration', v: values, issues, tests: catalogue.map((code) => ({ code, checked: chosen.has(code) })) });
  }

  @Post()
  @Roles('operator', 'technologist', 'approver')
  async register(@Req() req: WebRequest, @Res() res: Response, @Body() body: Form): Promise<void> {
    const birth = str(body, 'birthDate');
    const sex = str(body, 'sex');
    const values = {
      familyName: str(body, 'familyName'),
      givenName: str(body, 'givenName'),
      birthDate: birth,
      sex,
      claimedMrn: str(body, 'claimedMrn'),
      location: str(body, 'location'),
      clinician: str(body, 'clinician'),
      priority: str(body, 'priority') === 'stat' ? 'stat' : 'routine',
      specimenType: str(body, 'specimenType'),
      tests: list(body, 'tests'),
    } as const;
    if (birth && !/^\d{4}-\d{2}-\d{2}$/.test(birth)) return this.renderForm(req, res, values, ['Birth date must be a date.'], 422);
    try {
      const r = await registerDowntimeOrder(
        this.db,
        {
          familyName: values.familyName,
          givenName: values.givenName,
          claimedMrn: values.claimedMrn,
          location: values.location,
          clinician: values.clinician,
          priority: values.priority,
          specimenType: values.specimenType,
          tests: [...values.tests],
          ...(birth ? { birthDate: new Date(`${birth}T00:00:00Z`) } : {}),
          ...(sex === 'F' || sex === 'M' || sex === 'U' ? { sex } : {}),
        },
        req.user!.username,
      );
      res.redirect(303, `/orders/${r.orderId}?notice=downtime-registered`);
    } catch (e) {
      const detail = (e as { error?: { detail?: string } }).error?.detail;
      if (!detail) throw e;
      await this.renderForm(req, res, values, [detail.charAt(0).toUpperCase() + detail.slice(1) + '.'], 422);
    }
  }

  /** Reconciliation: candidate HMIS orders, best first; a person picks one and confirms with their password. */
  @Get(':id')
  async reconcilePage(@Req() req: WebRequest, @Res() res: Response, @Param('id') id: string): Promise<void> {
    const o = await this.db.labOrder.findUnique({ where: { id: uuidParam(id) }, include: { patient: true, tests: { include: { result: true } }, specimens: true } });
    if (!o || o.source !== DOWNTIME) throw new NotFoundException();
    const to = o.reconciledToId ? await this.db.labOrder.findUnique({ where: { id: o.reconciledToId } }) : null;
    const candidates = o.reconciledAt ? [] : await reconciliationCandidates(this.db, o.id);
    const src = o.sourceJson as { claimedMrn?: string | null; registeredBy?: string };
    page(req, res, 'downtime-reconcile', {
      title: `Reconcile ${o.hmisOrderId}`,
      o: { id: o.id, downtimeId: o.hmisOrderId, at: formatTime(o.orderedAt), by: src.registeredBy ?? '', reconciledAt: formatTime(o.reconciledAt), reconciledBy: o.reconciledBy ?? '', to: to ? { id: to.id, hmisOrderId: to.hmisOrderId } : null },
      patient: { name: name(o.patient), birthDate: day(o.patient.birthDate), sex: o.patient.sex ?? '', claimedMrn: src.claimedMrn ?? '' },
      tests: o.tests.map((t) => ({ code: t.localTestCode, state: t.result ? 'result' : t.specimenId ? 'collected' : t.status === 'reconciled' ? 'moved' : 'not collected' })),
      candidates: candidates.map((c) => ({
        orderId: c.orderId,
        hmisOrderId: c.hmisOrderId,
        at: formatTime(c.orderedAt),
        patient: `${name(c.patient)} · MRN ${c.patient.mrn}${c.patient.birthDate ? ` · born ${day(c.patient.birthDate)}` : ''}${c.patient.sex ? ` · ${c.patient.sex}` : ''}`,
        why: c.why.join(', ') || 'ordered around the same time',
        missing: c.missing.join(', '),
      })),
    });
  }

  @Post(':id/reconcile')
  @Roles('technologist', 'approver')
  async reconcile(@Req() req: WebRequest, @Res() res: Response, @Param('id') id: string, @Body() body: Form): Promise<void> {
    if (!(await confirmPassword(this.db, req.user!.id, str(body, 'password')))) throw new ForbiddenException('Password not confirmed. Nothing was changed.');
    // Either a candidate from the list, or an HMIS order number typed in.
    const typed = str(body, 'hmisOrderNo').trim();
    let target = str(body, 'hmisOrderId');
    if (!target && typed) {
      const found = await this.db.labOrder.findUnique({ where: { hmisOrderId: typed } });
      if (!found) throw new InvalidInput([`No HMIS order ${typed} has arrived yet.`]);
      target = found.id;
    }
    if (!target) throw new InvalidInput(['Choose the HMIS order.']);
    await reconcileDowntimeOrder(this.db, uuidParam(id), uuidParam(target), req.user!.username);
    res.redirect(303, `/orders/${target}?notice=reconciled`);
  }
}

import { Controller, Get, Inject, NotFoundException, Param, Req, Res } from '@nestjs/common';
import type { Db } from '@lis/db';
import { AUTOVERIFY_ACTOR } from '@lis/domain';
import { appendAudit, orderReport, reportHeader } from '@lis/lab';
import type { Response } from 'express';
import { page, uuidParam } from './controllers.js';
import { formatTime, formatValue, REFERENCE_MARK } from './format.js';
import type { WebRequest } from './security.js';
import { DB, WEB_OPTIONS, type WebOptions } from './tokens.js';

/** Printable result report for one order (09 W-14). */
@Controller('orders')
export class OrderReportController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(WEB_OPTIONS) private readonly opts: WebOptions,
  ) {}

  @Get(':id/report')
  async report(@Req() req: WebRequest, @Res() res: Response, @Param('id') id: string): Promise<void> {
    const o = await this.db.labOrder.findUnique({ where: { id: uuidParam(id) }, include: { patient: true, specimens: { orderBy: { createdAt: 'asc' }, include: { tests: { select: { specimenType: true } } } } } });
    if (!o) throw new NotFoundException();
    const lines = await orderReport(this.db, o.id);
    const usernames = [...new Set(lines.map((l) => l.approvedBy).filter((u): u is string => !!u && u !== AUTOVERIFY_ACTOR))];
    const users = new Map((await this.db.appUser.findMany({ where: { username: { in: usernames } }, select: { username: true, displayName: true } })).map((u) => [u.username, u.displayName]));
    const approved = lines.filter((l) => l.state === 'approved').length;
    const now = new Date();
    await this.db.$transaction((tx) => appendAudit(tx, { actor: req.user!.username, action: 'order.report-viewed', entityType: 'lab_order', entityId: o.id, after: { approved, pending: lines.filter((l) => l.state === 'pending').length } }));
    const p = o.patient;
    page(req, res, 'order-report', {
      title: `Report ${o.hmisOrderId}`,
      letterhead: (await reportHeader(this.db)) ?? { labName: this.opts.reportHeader ?? 'Laboratory report', reportTitle: 'Laboratory report', addressLines: [], logoVersion: null },
      printed: formatTime(now),
      printedBy: req.user!.displayName,
      o: { id: o.id, hmisOrderId: o.hmisOrderId, priority: o.priority, location: o.location ?? '', clinician: o.orderingClinician ?? '', orderedAt: formatTime(o.orderedAt), downtime: o.source === 'MANUAL_DOWNTIME' },
      patient: { name: [p.familyName?.toUpperCase(), p.givenName].filter(Boolean).join(', ') || '(no name)', mrn: p.mrn, sex: p.sex ?? '', birthDate: p.birthDate?.toISOString().slice(0, 10) ?? '', provisional: p.provisional },
      specimens: o.specimens.map((s) => ({ accessionNo: s.accessionNo, type: s.tests[0]?.specimenType ?? '', collected: formatTime(s.collectedAt), received: formatTime(s.receivedAt), rejected: s.status === 'rejected' })),
      lines: lines.map((l) => ({
        test: l.test,
        hmisTestCode: l.hmisTestCode !== l.test ? l.hmisTestCode : '',
        specimen: l.specimen ?? '',
        approved: l.state === 'approved',
        cancelled: l.state === 'cancelled',
        value: formatValue(l.value),
        units: l.units ?? '',
        flags: l.abnormalFlags.join(' '),
        critical: l.critical ?? '',
        corrected: l.corrected,
        referenceRange: l.labReference ? l.labReference.text : (l.referenceRange ?? ''),
        comments: l.comments,
        rangeSource: l.labReference ? 'lab' : l.referenceRange ? 'instrument' : '',
        mark: l.labReference?.mark ? (REFERENCE_MARK[l.labReference.mark] ?? '') : '',
        approvedBy: l.approvedBy === AUTOVERIFY_ACTOR ? 'autoverified' : l.approvedBy ? (users.get(l.approvedBy) ?? l.approvedBy) : '',
        approvedAt: formatTime(l.approvedAt),
      })),
      approved,
      pending: lines.some((l) => l.state === 'pending'),
    });
  }
}

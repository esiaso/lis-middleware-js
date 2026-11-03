import { randomBytes } from 'node:crypto';
import { Body, Controller, ForbiddenException, Get, Inject, NotFoundException, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { ResultValue, VerificationStatus } from '@lis/contracts';
import type { Db } from '@lis/db';
import { clinicalGateFor } from '@lis/domain';
import { approve, correct, dismissUnmatched, release, replay, review } from '@lis/lab';
import type { CookieOptions, Response } from 'express';
import { confirmPassword, login, logout } from './auth.js';
import { formatTime, formatValue, NOTICES, parseEnteredValue, safeNext, STATUS_LABELS } from './format.js';
import { LOGIN_CSRF_COOKIE, Public, Roles, SESSION_COOKIE, type WebRequest } from './security.js';
import { DB, WEB_OPTIONS, type WebOptions } from './tokens.js';

export type Form = Record<string, unknown>;
export const str = (f: Form | undefined, k: string): string => (typeof f?.[k] === 'string' ? (f[k] as string) : '');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function uuidParam(id: string): string {
  if (!UUID.test(id)) throw new NotFoundException();
  return id;
}

/** Render with the signed-in person, their CSRF token, and a fixed notice if the redirect asked for one. */
export function page(req: WebRequest, res: Response, view: string, data: Record<string, unknown>): void {
  const roles = req.user?.roles ?? [];
  const notice = typeof req.query['notice'] === 'string' ? NOTICES[req.query['notice']] : undefined;
  res.render(view, {
    ...data,
    user: req.user,
    csrf: req.user?.csrfToken,
    notice,
    can: {
      review: roles.includes('technologist') || roles.includes('approver'),
      approve: roles.includes('approver'),
      replay: roles.includes('approver') || roles.includes('admin'),
      dismiss: roles.includes('technologist') || roles.includes('approver'),
      register: roles.includes('admin') || roles.includes('technologist'),
      verify: roles.includes('admin') || roles.includes('approver'),
      accept: roles.includes('approver'),
    },
  });
}

function patientName(p: { familyName: string | null; givenName: string | null; mrn: string }): string {
  const name = [p.familyName?.toUpperCase(), p.givenName].filter(Boolean).join(', ');
  return name ? `${name} (${p.mrn})` : p.mrn;
}

@Controller()
export class AuthController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(WEB_OPTIONS) private readonly opts: WebOptions,
  ) {}

  private cookie(extra: CookieOptions): CookieOptions {
    return { httpOnly: true, secure: this.opts.secureCookies, ...extra };
  }

  /** Sign-in form. A pre-session CSRF token (double-submit cookie) protects the form itself. */
  private showLogin(req: WebRequest, res: Response, next: string, error?: string): void {
    const token = randomBytes(32).toString('hex');
    res.cookie(LOGIN_CSRF_COOKIE, token, this.cookie({ sameSite: 'strict', path: '/login', maxAge: 30 * 60_000 }));
    res.render('login', { title: 'Sign in', loginCsrf: token, next, error, notice: typeof req.query['notice'] === 'string' ? NOTICES[req.query['notice']] : undefined });
  }

  @Public()
  @Get('login')
  getLogin(@Req() req: WebRequest, @Res() res: Response): void {
    if (req.user) return res.redirect(303, '/');
    this.showLogin(req, res, safeNext(req.query['next']));
  }

  @Public()
  @Post('login')
  async postLogin(@Req() req: WebRequest, @Res() res: Response, @Body() body: Form): Promise<void> {
    const next = safeNext(str(body, 'next'));
    const expected = (req.cookies as Record<string, string | undefined>)[LOGIN_CSRF_COOKIE];
    if (!expected || str(body, '_csrf') !== expected) {
      res.status(403);
      return this.showLogin(req, res, next, 'The sign-in form expired. Try again.');
    }
    const r = await login(this.db, str(body, 'username').trim(), str(body, 'password'), this.opts.session);
    if (!r.ok) {
      res.status(401);
      return this.showLogin(req, res, next, r.reason === 'locked' ? 'This account is locked for 15 minutes after too many failed attempts.' : 'Wrong username or password.');
    }
    res.clearCookie(LOGIN_CSRF_COOKIE, { path: '/login' });
    res.cookie(SESSION_COOKIE, r.token, this.cookie({ sameSite: 'lax', path: '/', maxAge: this.opts.session.absoluteMs }));
    res.redirect(303, next);
  }

  @Post('logout')
  async postLogout(@Req() req: WebRequest, @Res() res: Response): Promise<void> {
    await logout(this.db, req.sessionToken);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.redirect(303, '/login?notice=signedout');
  }
}

@Controller()
export class DashboardController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  async dashboard(@Req() req: WebRequest, @Res() res: Response): Promise<void> {
    const now = new Date();
    const [instruments, byStatus, unmatched, failedOutbox, needsConfirmation] = await Promise.all([
      this.db.instrument.findMany({ orderBy: { displayName: 'asc' }, include: { lease: true } }),
      this.db.result.groupBy({ by: ['status'], _count: { _all: true } }),
      this.db.unmatchedResult.count({ where: { resolvedAt: null } }),
      this.db.outboxMessage.count({ where: { status: { in: ['FAILED', 'DEAD'] } } }),
      this.db.result.count({ where: { needsConfirmation: true } }),
    ]);
    const counts = Object.fromEntries(byStatus.map((g) => [g.status, g._count._all]));
    page(req, res, 'dashboard', {
      title: 'Dashboard',
      instruments: instruments.map((i) => {
        const gate = clinicalGateFor({
          enabled: i.enabled,
          verificationStatus: i.verificationStatus.toLowerCase() as VerificationStatus,
          softwareVersion: i.softwareVersion,
          verifiedSoftwareVersion: i.verifiedSoftwareVersion,
        });
        return {
          id: i.id,
          href: `/instruments/${encodeURIComponent(i.id)}`,
          name: i.displayName,
          model: `${i.manufacturer} ${i.model}`,
          verification: i.verificationStatus.replace('_', ' ').toLowerCase(),
          enabled: i.enabled,
          clinical: gate.releasable,
          gateDetail: gate.releasable ? '' : gate.detail,
          linked: !!i.lease && i.lease.leaseUntil > now,
        };
      }),
      tiles: [
        { label: 'To review', n: counts['received'] ?? 0, href: '/results?status=received' },
        { label: 'To approve', n: counts['reviewed'] ?? 0, href: '/results?status=reviewed' },
        { label: 'Approved, not released', n: counts['approved'] ?? 0, href: '/results?status=approved' },
        { label: 'Unmatched', n: unmatched, href: '/unmatched' },
        { label: 'Failed deliveries', n: (counts['failed'] ?? 0) + failedOutbox + needsConfirmation, href: '/failed', alert: true },
      ],
    });
  }
}

@Controller('results')
export class ResultsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(WEB_OPTIONS) private readonly opts: WebOptions,
  ) {}

  @Get()
  async list(@Req() req: WebRequest, @Res() res: Response, @Query('status') status?: string): Promise<void> {
    const filter = status && status in STATUS_LABELS ? status : undefined;
    const rows = await this.db.result.findMany({
      where: filter ? { status: filter } : {},
      orderBy: { updatedAt: 'desc' },
      take: 200,
      include: { versions: true, orderedTest: { include: { order: { include: { patient: true } }, specimen: true } } },
    });
    page(req, res, 'results', {
      title: 'Results',
      filter,
      statuses: Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label, active: value === filter })),
      rows: rows.map((r) => {
        const v = r.versions.find((x) => x.versionNo === r.selectedVersionNo);
        return {
          id: r.id,
          patient: patientName(r.orderedTest.order.patient),
          accessionNo: r.orderedTest.specimen?.accessionNo ?? '',
          test: r.orderedTest.localTestCode ?? r.orderedTest.hmisTestCode,
          value: formatValue(v?.value as ResultValue | undefined),
          units: v?.units ?? '',
          flags: v?.abnormalFlags.join(' ') ?? '',
          status: STATUS_LABELS[r.status] ?? r.status,
          attention: r.newDataAfterApproval || r.needsConfirmation,
          updated: formatTime(r.updatedAt),
        };
      }),
    });
  }

  @Get(':id')
  async detail(@Req() req: WebRequest, @Res() res: Response, @Param('id') id: string): Promise<void> {
    const r = await this.db.result.findUnique({
      where: { id: uuidParam(id) },
      include: {
        versions: { orderBy: { versionNo: 'asc' } },
        events: { orderBy: { at: 'asc' } },
        orderedTest: { include: { order: { include: { patient: true } }, specimen: true } },
      },
    });
    if (!r) throw new NotFoundException();
    const inst = r.instrumentId ? await this.db.instrument.findUnique({ where: { id: r.instrumentId } }) : null;
    const gate = inst
      ? clinicalGateFor({
          enabled: inst.enabled,
          verificationStatus: inst.verificationStatus.toLowerCase() as VerificationStatus,
          softwareVersion: inst.softwareVersion,
          verifiedSoftwareVersion: inst.verifiedSoftwareVersion,
        })
      : ({ releasable: true } as const);
    const t = r.orderedTest;
    page(req, res, 'result', {
      title: `Result ${t.localTestCode ?? t.hmisTestCode}`,
      r: {
        id: r.id,
        status: STATUS_LABELS[r.status] ?? r.status,
        reviewedBy: r.reviewedBy,
        approvedBy: r.approvedBy,
        newDataAfterApproval: r.newDataAfterApproval,
        needsConfirmation: r.needsConfirmation,
      },
      patient: patientName(t.order.patient),
      order: { hmisOrderId: t.order.hmisOrderId, priority: t.order.priority, orderedAt: formatTime(t.order.orderedAt) },
      test: { local: t.localTestCode, hmis: t.hmisTestCode },
      specimen: t.specimen ? { accessionNo: t.specimen.accessionNo, collectedAt: formatTime(t.specimen.collectedAt) } : null,
      instrument: inst ? { name: inst.displayName, model: `${inst.manufacturer} ${inst.model}` } : null,
      notClinical: gate.releasable ? null : gate.detail,
      versions: r.versions.map((v) => ({
        no: v.versionNo,
        kind: v.kind,
        value: formatValue(v.value as unknown as ResultValue),
        units: v.units ?? '',
        flags: v.abnormalFlags.join(' '),
        reason: v.reason,
        by: v.createdBy,
        at: formatTime(v.createdAt),
        selected: v.versionNo === r.selectedVersionNo,
      })),
      events: r.events.map((e) => ({ kind: e.kind, version: e.versionNo, actor: e.actor, reason: e.reason, at: formatTime(e.at) })),
      actions: {
        review: r.status === 'received' || r.status === 'reviewed',
        approve: r.status === 'reviewed',
        release: r.status === 'approved' && gate.releasable,
        replay: r.status === 'failed',
        correct: r.status === 'sent' || r.status === 'hmis_confirmed',
      },
      twoPersonRule: this.opts.twoPersonRule,
    });
  }

  @Post(':id/review')
  @Roles('technologist', 'approver')
  async review(@Req() req: WebRequest, @Res() res: Response, @Param('id') id: string, @Body() body: Form): Promise<void> {
    await review(this.db, uuidParam(id), req.user!.username, Number(str(body, 'versionNo')));
    res.redirect(303, `/results/${id}?notice=reviewed`);
  }

  private async stepUp(req: WebRequest, body: Form): Promise<void> {
    if (!(await confirmPassword(this.db, req.user!.id, str(body, 'password')))) throw new ForbiddenException('Password not confirmed. Nothing was changed.');
  }

  @Post(':id/approve')
  @Roles('approver')
  async approve(@Req() req: WebRequest, @Res() res: Response, @Param('id') id: string, @Body() body: Form): Promise<void> {
    await this.stepUp(req, body);
    await approve(this.db, uuidParam(id), req.user!.username, { twoPersonRule: this.opts.twoPersonRule });
    res.redirect(303, `/results/${id}?notice=approved`);
  }

  @Post(':id/release')
  @Roles('approver')
  async release(@Req() req: WebRequest, @Res() res: Response, @Param('id') id: string, @Body() body: Form): Promise<void> {
    await this.stepUp(req, body);
    await release(this.db, uuidParam(id), { username: req.user!.username, displayName: req.user!.displayName });
    res.redirect(303, `/results/${id}?notice=released`);
  }

  @Post(':id/replay')
  @Roles('approver', 'admin')
  async replay(@Req() req: WebRequest, @Res() res: Response, @Param('id') id: string, @Body() body: Form): Promise<void> {
    await replay(this.db, uuidParam(id), req.user!.username, str(body, 'reason'));
    res.redirect(303, `/results/${id}?notice=replayed`);
  }

  @Post(':id/correct')
  @Roles('approver')
  async correct(@Req() req: WebRequest, @Res() res: Response, @Param('id') id: string, @Body() body: Form): Promise<void> {
    await this.stepUp(req, body);
    const value = parseEnteredValue(str(body, 'value'));
    if (!value) throw new ForbiddenException('Enter the corrected value.');
    const units = str(body, 'units').trim();
    await correct(this.db, uuidParam(id), req.user!.username, value, str(body, 'reason'), units || undefined);
    res.redirect(303, `/results/${id}?notice=corrected`);
  }
}

@Controller('unmatched')
export class UnmatchedController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  async list(@Req() req: WebRequest, @Res() res: Response): Promise<void> {
    const rows = await this.db.unmatchedResult.findMany({ where: { resolvedAt: null }, orderBy: { createdAt: 'desc' }, take: 200 });
    const obs = await this.db.observation.findMany({ where: { id: { in: rows.map((r) => r.observationId) } } });
    const byId = new Map(obs.map((o) => [o.id, o]));
    page(req, res, 'unmatched', {
      title: 'Unmatched results',
      rows: rows.map((u) => {
        const o = byId.get(u.observationId);
        return {
          id: u.id,
          reason: u.reason.replaceAll('_', ' ').toLowerCase(),
          sampleId: u.sampleId ?? '(no barcode)',
          instrumentId: u.instrumentId,
          test: o?.instrumentTestCode ?? '',
          value: o?.originalValueText ?? '',
          units: o?.units ?? '',
          at: formatTime(u.createdAt),
        };
      }),
    });
  }

  @Post(':id/dismiss')
  @Roles('technologist', 'approver')
  async dismiss(@Req() req: WebRequest, @Res() res: Response, @Param('id') id: string, @Body() body: Form): Promise<void> {
    await dismissUnmatched(this.db, uuidParam(id), req.user!.username, str(body, 'reason'));
    res.redirect(303, '/unmatched?notice=dismissed');
  }
}

@Controller('failed')
export class FailedController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  async list(@Req() req: WebRequest, @Res() res: Response): Promise<void> {
    const [outbox, results] = await Promise.all([
      this.db.outboxMessage.findMany({ where: { status: { in: ['FAILED', 'DEAD'] } }, orderBy: { createdAt: 'desc' }, take: 200 }),
      this.db.result.findMany({
        where: { OR: [{ status: 'failed' }, { needsConfirmation: true }] },
        orderBy: { updatedAt: 'desc' },
        take: 200,
        include: { orderedTest: { include: { order: { include: { patient: true } } } } },
      }),
    ]);
    page(req, res, 'failed', {
      title: 'Failed deliveries',
      results: results.map((r) => ({
        id: r.id,
        patient: patientName(r.orderedTest.order.patient),
        test: r.orderedTest.localTestCode ?? r.orderedTest.hmisTestCode,
        status: r.needsConfirmation ? 'Outcome unknown: checking with the HMIS' : STATUS_LABELS[r.status],
        updated: formatTime(r.updatedAt),
      })),
      outbox: outbox.map((m) => ({
        topic: m.topic,
        key: m.idempotencyKey,
        resultId: m.resultId,
        status: m.status,
        attempts: m.attempts,
        error: m.lastError ?? '',
        at: formatTime(m.createdAt),
      })),
    });
  }
}

@Controller('health')
export class HealthController {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** For the service monitor. Says only whether the database answers; no detail leaks out. */
  @Public()
  @Get()
  async health(@Res() res: Response): Promise<void> {
    try {
      await this.db.$queryRaw`SELECT 1`;
      res.json({ status: 'ok' });
    } catch {
      res.status(503).json({ status: 'unavailable' });
    }
  }
}

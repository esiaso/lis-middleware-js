import { randomBytes } from 'node:crypto';
import { Body, Controller, ForbiddenException, Get, Inject, NotFoundException, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { ResultValue, VerificationStatus } from '@lis/contracts';
import { migrationStatus, type Db } from '@lis/db';
import { AUTOVERIFY_ACTOR, clinicalGateFor } from '@lis/domain';
import { activeEntry, addResultComment, approve, confirmLink, decisionsFor, failingQc, hmisLinkStatus, instrumentReferenceText, labReferences, overdueResults, correct, dismissUnmatched, NEEDS_CALL, proposeLink, release, replay, review, standardCommentsFor, waitingCriticals, withdrawLink, withdrawResultComment } from '@lis/lab';
import type { CookieOptions, Response } from 'express';
import { confirmIdentity, login, logout, oidcSignIn, recordStepUp, STEP_UP_MS, type LoginResult } from './auth.js';
import { directory } from './ldap.js';
import { displayTimeZone, elapsed, formatTime, formatValue, NOTICES, REFERENCE_MARK, parseEnteredValue, safeNext, STATUS_LABELS } from './format.js';
import { LOGIN_CSRF_COOKIE, OpenDuringPasswordChange, Public, Roles, SESSION_COOKIE, type WebRequest } from './security.js';
import { CALLBACK_PATH, FLIGHT_MS, OIDC_COOKIE, OidcRefused, START_PATH, STEP_UP_PATH, type Oidc } from './oidc.js';
import { DB, OIDC, WEB_OPTIONS, type WebOptions } from './tokens.js';

export type Form = Record<string, unknown>;
export const str = (f: Form | undefined, k: string): string => (typeof f?.[k] === 'string' ? (f[k] as string) : '');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function uuidParam(id: string): string {
  if (!UUID.test(id)) throw new NotFoundException();
  return id;
}

/**
 * Confirm it is still this person before an approval-type action (10 §3).
 * Local accounts type their password into the form; hospital sign-in
 * accounts confirm at the IdP first, once per action.
 */
export async function requireStepUp(db: Db, req: WebRequest, password: string): Promise<void> {
  if (await confirmIdentity(db, req.user!, req.sessionToken, password)) return;
  throw new ForbiddenException(req.user!.sso ? 'Confirm with the hospital sign-in first; each confirmation is good for one action within 5 minutes. Nothing was changed.' : 'Password not confirmed. Nothing was changed.');
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
    timeZone: displayTimeZone(),
    // For hospital sign-in accounts, forms that need re-confirmation show a link back to this page.
    stepUp: req.user?.sso
      ? {
          href: `${STEP_UP_PATH}?next=${encodeURIComponent(safeNext(req.originalUrl.replace(/([?&])notice=[^&]*&?/, '$1').replace(/[?&]$/, '')))}`,
          until: req.user.stepUpAt && Date.now() - req.user.stepUpAt.getTime() < STEP_UP_MS ? formatTime(new Date(req.user.stepUpAt.getTime() + STEP_UP_MS)) : '',
        }
      : undefined,
    can: {
      review: roles.includes('technologist') || roles.includes('approver'),
      approve: roles.includes('approver'),
      call: roles.includes('technologist') || roles.includes('approver'),
      replay: roles.includes('approver') || roles.includes('admin'),
      dismiss: roles.includes('technologist') || roles.includes('approver'),
      register: roles.includes('admin') || roles.includes('technologist'),
      verify: roles.includes('admin') || roles.includes('approver'),
      accept: roles.includes('approver'),
      collect: roles.includes('operator') || roles.includes('technologist') || roles.includes('approver'),
      reject: roles.includes('technologist') || roles.includes('approver'),
      audit: roles.includes('auditor'),
      exportReports: roles.includes('approver') || roles.includes('auditor'),
      users: roles.includes('admin'),
    },
  });
}

function patientName(p: { familyName: string | null; givenName: string | null; mrn: string }): string {
  const name = [p.familyName?.toUpperCase(), p.givenName].filter(Boolean).join(', ');
  return name ? `${name} (${p.mrn})` : p.mrn;
}

const LOGIN_REFUSED: Record<Exclude<LoginResult, { ok: true }>['reason'], string> = {
  invalid: 'Wrong username or password.',
  locked: 'This account is locked for 15 minutes after too many failed attempts.',
  unavailable: 'The hospital directory cannot be reached, so directory accounts cannot sign in. Try again, or use a local account.',
  'no-role': 'Your hospital account is not in any directory group that has access to the lab middleware. Ask IT or the lab manager.',
  disabled: 'This account is disabled in the lab middleware. Ask an administrator.',
  'name-taken': 'A local account already has your username, so the hospital sign-in cannot use it. Ask an administrator.',
  'bad-name': 'Your hospital username cannot be used here. Ask IT.',
};

@Controller()
export class AuthController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(WEB_OPTIONS) private readonly opts: WebOptions,
    @Inject(OIDC) private readonly oidc: Oidc | null,
  ) {}

  private cookie(extra: CookieOptions): CookieOptions {
    return { httpOnly: true, secure: this.opts.secureCookies, ...extra };
  }

  /** Sign-in form. A pre-session CSRF token (double-submit cookie) protects the form itself. */
  private showLogin(req: WebRequest, res: Response, next: string, error?: string): void {
    const token = randomBytes(32).toString('hex');
    res.cookie(LOGIN_CSRF_COOKIE, token, this.cookie({ sameSite: 'strict', path: '/login', maxAge: 30 * 60_000 }));
    res.render('login', {
      title: 'Sign in',
      loginCsrf: token,
      next,
      error,
      notice: typeof req.query['notice'] === 'string' ? NOTICES[req.query['notice']] : undefined,
      sso: this.oidc ? { label: this.oidc.settings.label, href: `${START_PATH}?next=${encodeURIComponent(next)}` } : undefined,
      directory: directory() ? { label: directory()!.label } : undefined,
    });
  }

  /** Send the browser to the hospital IdP (10 §3). */
  private async toIdp(res: Response, purpose: 'login' | 'step-up', next: string): Promise<void> {
    const { url, cookie } = await this.oidc!.start(purpose, next);
    res.cookie(OIDC_COOKIE, cookie, this.cookie({ sameSite: 'lax', path: START_PATH, maxAge: FLIGHT_MS }));
    res.redirect(303, url);
  }

  @Public()
  @Get(START_PATH.slice(1))
  async startOidc(@Req() req: WebRequest, @Res() res: Response): Promise<void> {
    if (!this.oidc) throw new NotFoundException();
    const next = safeNext(req.query['next']);
    if (req.user) return res.redirect(303, next);
    try {
      await this.toIdp(res, 'login', next);
    } catch (e) {
      res.status(503);
      this.showLogin(req, res, next, `The hospital sign-in cannot be reached (${(e as Error).message}). Try again, or use a local account.`);
    }
  }

  /** Re-confirm at the IdP before an approval-type action. Comes back to the page it started from. */
  @Get(STEP_UP_PATH.slice(1))
  async startStepUp(@Req() req: WebRequest, @Res() res: Response): Promise<void> {
    if (!this.oidc || !req.user!.sso) throw new NotFoundException();
    await this.toIdp(res, 'step-up', safeNext(req.query['next']));
  }

  @Public()
  @Get(CALLBACK_PATH.slice(1))
  async oidcCallback(@Req() req: WebRequest, @Res() res: Response): Promise<void> {
    if (!this.oidc) throw new NotFoundException();
    const cookie = (req.cookies as Record<string, string | undefined>)[OIDC_COOKIE];
    res.clearCookie(OIDC_COOKIE, { path: START_PATH });
    const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
    let done: Awaited<ReturnType<Oidc['finish']>>;
    try {
      done = await this.oidc.finish(query, cookie);
    } catch (e) {
      if (!(e instanceof OidcRefused)) throw e;
      if (req.user) throw new ForbiddenException(e.message);
      res.status(401);
      return this.showLogin(req, res, '/', e.message);
    }
    const { purpose, next, profile } = done;
    if (purpose === 'step-up') {
      if (!req.user || !req.sessionToken || !(await recordStepUp(this.db, req.sessionToken, req.user, profile))) throw new ForbiddenException('That hospital sign-in is not the person signed in here. Nothing was confirmed.');
      return res.redirect(303, next);
    }
    if (req.user) await logout(this.db, req.sessionToken);
    const r = await oidcSignIn(this.db, profile, this.opts.session);
    if (!r.ok) {
      res.status(403);
      return this.showLogin(req, res, next, LOGIN_REFUSED[r.reason]);
    }
    res.cookie(SESSION_COOKIE, r.token, this.cookie({ sameSite: 'lax', path: '/', maxAge: this.opts.session.absoluteMs }));
    res.redirect(303, next);
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
      res.status(r.reason === 'unavailable' ? 503 : r.reason === 'invalid' || r.reason === 'locked' ? 401 : 403);
      return this.showLogin(req, res, next, LOGIN_REFUSED[r.reason]);
    }
    res.clearCookie(LOGIN_CSRF_COOKIE, { path: '/login' });
    res.cookie(SESSION_COOKIE, r.token, this.cookie({ sameSite: 'lax', path: '/', maxAge: this.opts.session.absoluteMs }));
    res.redirect(303, next);
  }

  @OpenDuringPasswordChange()
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
    const [instruments, byStatus, unmatched, failedOutbox, needsConfirmation, criticals, qcFailing, overdue, hmis] = await Promise.all([
      this.db.instrument.findMany({ orderBy: { displayName: 'asc' }, include: { lease: true } }),
      this.db.result.groupBy({ by: ['status'], _count: { _all: true } }),
      this.db.unmatchedResult.count({ where: { resolvedAt: null } }),
      this.db.outboxMessage.count({ where: { status: { in: ['FAILED', 'DEAD'] } } }),
      this.db.result.count({ where: { needsConfirmation: true } }),
      waitingCriticals(this.db),
      failingQc(this.db),
      overdueResults(this.db, now),
      hmisLinkStatus(this.db, now),
    ]);
    const counts = Object.fromEntries(byStatus.map((g) => [g.status, g._count._all]));
    page(req, res, 'dashboard', {
      title: 'Dashboard',
      refresh: 60,
      hmis: hmis.warnings.length ? hmis.warnings.map((w) => w.text).join('; ') : null,
      overdue: overdue.length ? { n: overdue.length, oldest: elapsed(overdue[0]!.due, now) } : null,
      qcFailing: qcFailing.length ? { n: qcFailing.length, list: qcFailing.slice(0, 5).map((f) => `${f.instrumentName} ${f.localTestCode}`).join(', ') } : null,
      critical: criticals.length ? { n: criticals.length, oldest: elapsed(criticals[0]!.arrivedAt, now), more: criticals.length >= 100 } : null,
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
          critical: v?.criticalFlag && (NEEDS_CALL as readonly string[]).includes(v.criticalFlag) ? v.criticalFlag : '',
          delta: v?.deltaFlag === 'EXCEEDED' ? (v.deltaDetail ?? '') : '',
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
        criticalCalls: { orderBy: { recordedAt: 'asc' } },
        comments: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
        orderedTest: { include: { order: { include: { patient: true } }, specimen: true } },
      },
    });
    if (!r) throw new NotFoundException();
    const called = new Set(r.criticalCalls.map((c) => c.versionNo));
    const isCritical = (f: string | null) => !!f && (NEEDS_CALL as readonly string[]).includes(f);
    // Same rule as the waiting list: critical, no call yet, and not superseded before approval.
    const waiting = r.versions.filter((v) => isCritical(v.criticalFlag) && !called.has(v.versionNo) && v.versionNo >= (r.selectedVersionNo ?? 0));
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
    const decisions = await decisionsFor(this.db, r.id);
    const p = t.order.patient;
    const refs = await labReferences(this.db, r.versions.map((v) => ({ localTestCode: t.localTestCode, sex: p.sex, birthDate: p.birthDate, collectedAt: t.specimen?.collectedAt ?? null, storedAt: v.createdAt, value: v.value as unknown as ResultValue, units: v.units })));
    const shownVersion = r.versions.find((v) => v.versionNo === r.selectedVersionNo) ?? r.versions[r.versions.length - 1];
    const shownRef = shownVersion ? refs[r.versions.indexOf(shownVersion)] : null;
    const entry = r.events.find((e) => e.kind === 'enter');
    const entryDetail = (entry?.detail ?? {}) as { performedBy?: string; lot?: string };
    const def = t.localTestCode ? await activeEntry(this.db, t.localTestCode) : null;
    // A coded answer is shown with the catalogue's words next to its code.
    const shown = (v: ResultValue) => {
      if (v.kind !== 'qualitative') return formatValue(v);
      const words = def?.answers.find((a) => a.code === v.code)?.display;
      return words ? `${words} (${v.code})` : v.code;
    };
    page(req, res, 'result', {
      manual: entry ? { performedBy: entryDetail.performedBy ?? entry.actor, enteredBy: entry.actor, lot: entryDetail.lot ?? '' } : null,
      reference: shownRef ? { lab: true, text: shownRef.text, who: shownRef.who, source: shownRef.source } : shownVersion ? { lab: false, text: (await instrumentReferenceText(this.db, shownVersion.observationId)) ?? '' } : null,
      title: `Result ${t.localTestCode ?? t.hmisTestCode}`,
      r: {
        id: r.id,
        status: STATUS_LABELS[r.status] ?? r.status,
        reviewedBy: r.reviewedBy,
        approvedBy: r.approvedBy,
        autoverified: r.approvedBy === AUTOVERIFY_ACTOR,
        newDataAfterApproval: r.newDataAfterApproval,
        needsConfirmation: r.needsConfirmation,
      },
      patient: patientName(t.order.patient),
      patientId: t.order.patient.id,
      order: { hmisOrderId: t.order.hmisOrderId, priority: t.order.priority, orderedAt: formatTime(t.order.orderedAt) },
      test: { local: t.localTestCode, hmis: t.hmisTestCode },
      specimen: t.specimen ? { accessionNo: t.specimen.accessionNo, collectedAt: formatTime(t.specimen.collectedAt) } : null,
      instrument: inst ? { name: inst.displayName, model: `${inst.manufacturer} ${inst.model}` } : null,
      notClinical: gate.releasable ? null : gate.detail,
      downtime: t.order.source === 'MANUAL_DOWNTIME' ? { orderId: t.order.id, id: t.order.hmisOrderId } : null,
      versions: r.versions.map((v) => ({
        no: v.versionNo,
        kind: v.kind,
        value: shown(v.value as unknown as ResultValue),
        units: v.units ?? '',
        flags: v.abnormalFlags.join(' '),
        reason: v.reason,
        by: v.createdBy,
        at: formatTime(v.createdAt),
        selected: v.versionNo === r.selectedVersionNo,
        critical: isCritical(v.criticalFlag) ? v.criticalFlag : '',
        unitsDiffer: v.criticalFlag === 'UNITS_DIFFER' ? (v.criticalDetail ?? '') : '',
        delta: v.deltaFlag ? { exceeded: v.deltaFlag === 'EXCEEDED', detail: v.deltaDetail ?? '', previous: v.deltaPreviousResultId ? `/results/${v.deltaPreviousResultId}` : '' } : null,
        called: called.has(v.versionNo),
        mark: (() => {
          const m = refs[r.versions.indexOf(v)]?.mark;
          return m ? (REFERENCE_MARK[m] ?? '') : '';
        })(),
      })),
      critical: waiting.length
        ? waiting.map((v) => ({ no: v.versionNo, value: formatValue(v.value as unknown as ResultValue), units: v.units ?? '', flag: v.criticalFlag, detail: v.criticalDetail ?? '', waiting: elapsed(v.createdAt) }))
        : null,
      calls: r.criticalCalls.map((c) => ({ version: c.versionNo, notified: c.notified, role: c.notifiedRole, at: formatTime(c.calledAt), by: c.recordedBy, recordedAt: formatTime(c.recordedAt), note: c.note ?? '' })),
      autoverify: decisions.map((d) => ({ version: d.versionNo, passed: d.passed, at: formatTime(d.at), reference: d.reference, failed: d.checks.filter((c) => !c.ok), checks: d.checks })),
      standardComments: (await standardCommentsFor(this.db, t.localTestCode)).map((c) => ({ id: c.id, code: c.code, text: c.text })),
      comments: r.comments.map((c) => ({ id: c.id, text: c.text, onReport: c.onReport, by: c.createdBy, at: formatTime(c.createdAt), withdrawn: c.withdrawnAt ? { by: c.withdrawnBy, at: formatTime(c.withdrawnAt), reason: c.withdrawReason } : null })),
      events: r.events.map((e) => ({ kind: e.kind, version: e.versionNo, actor: e.actor, reason: e.reason, at: formatTime(e.at) })),
      actions: {
        review: r.status === 'received' || r.status === 'reviewed',
        approve: r.status === 'reviewed',
        release: r.status === 'approved' && gate.releasable && t.order.source !== 'MANUAL_DOWNTIME',
        replay: r.status === 'failed',
        correct: r.status === 'sent' || r.status === 'hmis_confirmed',
      },
      twoPersonRule: this.opts.twoPersonRule,
    });
  }

  /** A comment on the result (A-26). One printed on the report is an approver's call. */
  @Post(':id/comments')
  @Roles('technologist', 'approver')
  async comment(@Req() req: WebRequest, @Res() res: Response, @Param('id') id: string, @Body() body: Form): Promise<void> {
    const onReport = str(body, 'onReport') === 'yes';
    if (onReport && !req.user!.roles.includes('approver')) throw new ForbiddenException('Only an approver can add a comment to the printed report.');
    const standard = str(body, 'standard');
    await addResultComment(this.db, uuidParam(id), req.user!.username, { text: str(body, 'text'), onReport, ...(standard ? { standardId: uuidParam(standard) } : {}) });
    res.redirect(303, `/results/${id}?notice=comment-added`);
  }

  @Post(':id/comments/:commentId/withdraw')
  @Roles('technologist', 'approver')
  async withdrawComment(@Req() req: WebRequest, @Res() res: Response, @Param('id') id: string, @Param('commentId') commentId: string, @Body() body: Form): Promise<void> {
    const c = await this.db.resultComment.findUnique({ where: { id: uuidParam(commentId) } });
    if (!c || c.resultId !== uuidParam(id)) throw new NotFoundException();
    if (c.onReport && !req.user!.roles.includes('approver')) throw new ForbiddenException('Only an approver can withdraw a comment from the printed report.');
    await withdrawResultComment(this.db, c.id, req.user!.username, str(body, 'reason'));
    res.redirect(303, `/results/${id}?notice=comment-withdrawn`);
  }

  @Post(':id/review')
  @Roles('technologist', 'approver')
  async review(@Req() req: WebRequest, @Res() res: Response, @Param('id') id: string, @Body() body: Form): Promise<void> {
    await review(this.db, uuidParam(id), req.user!.username, Number(str(body, 'versionNo')));
    res.redirect(303, `/results/${id}?notice=reviewed`);
  }

  private async stepUp(req: WebRequest, body: Form): Promise<void> {
    await requireStepUp(this.db, req, str(body, 'password'));
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
          proposed: Boolean(u.proposedBy),
        };
      }),
    });
  }

  /** W-7 resolve: what the instrument sent, and any proposed link with the patient it would go to. */
  @Get(':id')
  async detail(@Req() req: WebRequest, @Res() res: Response, @Param('id') id: string): Promise<void> {
    const u = await this.db.unmatchedResult.findUnique({ where: { id: uuidParam(id) } });
    if (!u) throw new NotFoundException();
    const o = await this.db.observation.findUniqueOrThrow({ where: { id: u.observationId }, include: { normalizedMessage: true } });
    const target = u.proposedTestId
      ? await this.db.orderedTest.findUnique({ where: { id: u.proposedTestId }, include: { specimen: true, order: { include: { patient: true } } } })
      : null;
    const p = target?.order.patient;
    page(req, res, 'unmatched-detail', {
      title: 'Unmatched result',
      u: {
        id: u.id,
        reason: u.reason.replaceAll('_', ' ').toLowerCase(),
        at: formatTime(u.createdAt),
        resolved: Boolean(u.resolvedAt),
        resolution: u.resolution ?? '',
        resolvedBy: u.resolvedBy ?? '',
        linkedResultId: u.linkedResultId ?? '',
      },
      obs: {
        instrumentId: o.normalizedMessage.instrumentId,
        sampleId: o.normalizedMessage.sampleId ?? '(no barcode)',
        readError: o.normalizedMessage.sampleIdReadError,
        code: o.instrumentTestCode,
        local: o.localTestCode ?? '',
        mapped: o.mapping === 'MAPPED' && Boolean(o.localTestCode),
        value: o.originalValueText,
        units: o.units ?? '',
        flags: o.abnormalFlags.join(' '),
      },
      proposal: target
        ? {
            by: u.proposedBy,
            at: formatTime(u.proposedAt),
            reason: u.proposalReason ?? '',
            accessionNo: target.specimen?.accessionNo ?? '',
            specimenId: target.specimen?.id ?? '',
            test: target.localTestCode ?? target.hmisTestCode,
            hmisOrderId: target.order.hmisOrderId,
            patient: p ? `${[p.familyName?.toUpperCase(), p.givenName].filter(Boolean).join(', ') || '(no name)'} · MRN ${p.mrn}${p.birthDate ? ` · born ${p.birthDate.toISOString().slice(0, 10)}` : ''}` : '',
            mine: u.proposedBy === req.user!.username,
          }
        : null,
    });
  }

  @Post(':id/propose')
  @Roles('technologist', 'approver')
  async propose(@Req() req: WebRequest, @Res() res: Response, @Param('id') id: string, @Body() body: Form): Promise<void> {
    await proposeLink(this.db, uuidParam(id), req.user!.username, { accessionNo: str(body, 'accessionNo'), reason: str(body, 'reason') });
    res.redirect(303, `/unmatched/${id}?notice=link-proposed`);
  }

  @Post(':id/withdraw')
  @Roles('technologist', 'approver')
  async withdraw(@Req() req: WebRequest, @Res() res: Response, @Param('id') id: string): Promise<void> {
    await withdrawLink(this.db, uuidParam(id), req.user!.username);
    res.redirect(303, `/unmatched/${id}?notice=link-withdrawn`);
  }

  /** Second person, with password re-entry: the result reaches a patient's record only here. */
  @Post(':id/confirm')
  @Roles('technologist', 'approver')
  async confirm(@Req() req: WebRequest, @Res() res: Response, @Param('id') id: string, @Body() body: Form): Promise<void> {
    await requireStepUp(this.db, req, str(body, 'password'));
    const { resultId } = await confirmLink(this.db, uuidParam(id), req.user!.username);
    res.redirect(303, `/results/${resultId}?notice=linked`);
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

@Controller()
export class HealthController {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** For the service monitor. Says only whether the database answers; no detail leaks out. */
  @Public()
  @Get('health')
  async health(@Res() res: Response): Promise<void> {
    try {
      await this.db.$queryRaw`SELECT 1`;
      res.json({ status: 'ok' });
    } catch {
      res.status(503).json({ status: 'unavailable' });
    }
  }

  /** 11 §7: the process is up. */
  @Public()
  @Get('api/v1/health/live')
  live(@Res() res: Response): void {
    res.json({ status: 'ok' });
  }

  /** 11 §7: database reachable and every migration this build expects is applied. */
  @Public()
  @Get('api/v1/health/ready')
  async ready(@Res() res: Response): Promise<void> {
    try {
      const m = await migrationStatus(this.db);
      if (m.ok) res.json({ status: 'ok' });
      else res.status(503).json({ status: 'not-ready', reason: m.failed.length ? 'a migration failed' : 'migrations not applied' });
    } catch {
      res.status(503).json({ status: 'unavailable' });
    }
  }
}

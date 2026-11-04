import { Body, Controller, ForbiddenException, Get, Inject, NotFoundException, Param, Post, Req, Res } from '@nestjs/common';
import type { Db } from '@lis/db';
import { InvalidInput } from '@lis/lab';
import type { Response } from 'express';
import {
  changeOwnPassword, checkRoles, confirmPassword, createUser, resetUserPassword, ROLES, setUserActive, setUserRoles, unlockUser, USERNAME, validatePassword,
} from './auth.js';
import { page, str, uuidParam, type Form } from './controllers.js';
import { formatTime } from './format.js';
import { OpenDuringPasswordChange, Roles, type WebRequest } from './security.js';
import { DB } from './tokens.js';

const ROLE_NOTES: Record<string, string> = {
  admin: 'accounts, instruments, configuration',
  technologist: 'collect, review, resolve unmatched, mapping drafts',
  approver: 'approve and release results, lab acceptance, approve mappings',
  operator: 'register downtime orders, collect, receive, print labels',
  auditor: 'read-only, audit search and export',
};

function chosenRoles(body: Form): string[] {
  const raw = body['roles'];
  return (Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : []).filter((x): x is string => typeof x === 'string');
}

/** Admins manage accounts (10 §2). Every change needs the admin's own password again. */
@Controller('users')
@Roles('admin')
export class UsersController {
  constructor(@Inject(DB) private readonly db: Db) {}

  private async stepUp(req: WebRequest, body: Form): Promise<void> {
    if (!(await confirmPassword(this.db, req.user!.id, str(body, 'adminPassword')))) throw new ForbiddenException('Your password was not confirmed. Nothing was changed.');
  }

  @Get()
  async list(@Req() req: WebRequest, @Res() res: Response): Promise<void> {
    const users = await this.db.appUser.findMany({ orderBy: [{ active: 'desc' }, { username: 'asc' }] });
    const now = new Date();
    page(req, res, 'users', {
      title: 'Users',
      rows: users.map((u) => ({
        id: u.id,
        username: u.username,
        displayName: u.displayName,
        roles: u.roles.join(', '),
        active: u.active,
        locked: Boolean(u.lockedUntil && u.lockedUntil > now),
        mustChange: u.mustChangePassword,
      })),
    });
  }

  @Get('new')
  newForm(@Req() req: WebRequest, @Res() res: Response): void {
    this.renderNew(req, res, {}, [], 200);
  }

  private renderNew(req: WebRequest, res: Response, v: Record<string, unknown>, issues: string[], status: number): void {
    const chosen = new Set((v['roles'] as string[] | undefined) ?? []);
    res.status(status);
    page(req, res, 'user-new', { title: 'New user', v, issues, roles: ROLES.map((r) => ({ value: r, note: ROLE_NOTES[r], checked: chosen.has(r) })) });
  }

  @Post()
  async create(@Req() req: WebRequest, @Res() res: Response, @Body() body: Form): Promise<void> {
    const v = { username: str(body, 'username').trim().toLowerCase(), displayName: str(body, 'displayName').trim(), roles: chosenRoles(body) };
    const issues: string[] = [];
    if (!USERNAME.test(v.username)) issues.push('Username: 2 to 40 characters, lower-case letters, digits, dot, dash or underscore, starting with a letter or digit.');
    if (v.displayName.length < 2) issues.push('Display name is required.');
    const pw = str(body, 'password');
    const problem = validatePassword(pw);
    if (problem) issues.push(`Temporary ${problem}.`);
    try {
      checkRoles(v.roles);
    } catch (e) {
      if (e instanceof InvalidInput) issues.push(...e.issues);
      else throw e;
    }
    if (!issues.length && (await this.db.appUser.findUnique({ where: { username: v.username } }))) issues.push(`Username ${v.username} is already taken.`);
    if (issues.length) return this.renderNew(req, res, v, issues, 422);
    await this.stepUp(req, body);
    const id = await createUser(this.db, { username: v.username, displayName: v.displayName, password: pw, roles: checkRoles(v.roles), mustChangePassword: true }, req.user!.username);
    res.redirect(303, `/users/${id}?notice=user-created`);
  }

  @Get(':id')
  async detail(@Req() req: WebRequest, @Res() res: Response, @Param('id') id: string): Promise<void> {
    const u = await this.db.appUser.findUnique({ where: { id: uuidParam(id) }, include: { sessions: true } });
    if (!u) throw new NotFoundException();
    const history = await this.db.auditEvent.findMany({ where: { entityType: 'app_user', entityId: u.id, action: { startsWith: 'user.' } }, orderBy: { seq: 'desc' }, take: 50 });
    const now = new Date();
    page(req, res, 'user', {
      title: `User ${u.username}`,
      u: {
        id: u.id,
        username: u.username,
        displayName: u.displayName,
        active: u.active,
        locked: Boolean(u.lockedUntil && u.lockedUntil > now),
        lockedUntil: formatTime(u.lockedUntil),
        mustChange: u.mustChangePassword,
        passwordChangedAt: formatTime(u.passwordChangedAt),
        createdAt: formatTime(u.createdAt),
        sessions: u.sessions.filter((s) => s.expiresAt > now).length,
        self: u.id === req.user!.id,
      },
      roles: ROLES.map((r) => ({ value: r, note: ROLE_NOTES[r], checked: u.roles.includes(r) })),
      history: history.map((h) => ({ at: formatTime(h.at), actor: h.actor, action: h.action, reason: h.reason ?? '', after: h.after ? JSON.stringify(h.after) : '' })),
    });
  }

  @Post(':id/roles')
  async roles(@Req() req: WebRequest, @Res() res: Response, @Param('id') id: string, @Body() body: Form): Promise<void> {
    await this.stepUp(req, body);
    await setUserRoles(this.db, req.user!, uuidParam(id), chosenRoles(body));
    res.redirect(303, `/users/${id}?notice=roles-saved`);
  }

  @Post(':id/active')
  async active(@Req() req: WebRequest, @Res() res: Response, @Param('id') id: string, @Body() body: Form): Promise<void> {
    await this.stepUp(req, body);
    const on = str(body, 'active') === 'yes';
    await setUserActive(this.db, req.user!, uuidParam(id), on, str(body, 'reason'));
    res.redirect(303, `/users/${id}?notice=${on ? 'user-enabled' : 'user-disabled'}`);
  }

  @Post(':id/unlock')
  async unlock(@Req() req: WebRequest, @Res() res: Response, @Param('id') id: string, @Body() body: Form): Promise<void> {
    await this.stepUp(req, body);
    await unlockUser(this.db, req.user!, uuidParam(id));
    res.redirect(303, `/users/${id}?notice=user-unlocked`);
  }

  @Post(':id/password')
  async reset(@Req() req: WebRequest, @Res() res: Response, @Param('id') id: string, @Body() body: Form): Promise<void> {
    await this.stepUp(req, body);
    await resetUserPassword(this.db, req.user!, uuidParam(id), str(body, 'password'));
    res.redirect(303, `/users/${id}?notice=password-reset`);
  }
}

/** Every signed-in person: choose a new password (required after an administrator set a temporary one). */
@Controller('account')
export class AccountController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get('password')
  @OpenDuringPasswordChange()
  form(@Req() req: WebRequest, @Res() res: Response): void {
    page(req, res, 'account-password', { title: 'Change password', issues: [], forced: req.user!.mustChangePassword });
  }

  @Post('password')
  @OpenDuringPasswordChange()
  async change(@Req() req: WebRequest, @Res() res: Response, @Body() body: Form): Promise<void> {
    const next = str(body, 'newPassword');
    if (next !== str(body, 'confirmPassword')) {
      res.status(422);
      return page(req, res, 'account-password', { title: 'Change password', issues: ['The two new passwords are not the same.'], forced: req.user!.mustChangePassword });
    }
    try {
      await changeOwnPassword(this.db, req.user!, str(body, 'currentPassword'), next, req.sessionToken);
    } catch (e) {
      if (!(e instanceof InvalidInput)) throw e;
      res.status(422);
      return page(req, res, 'account-password', { title: 'Change password', issues: e.issues, forced: req.user!.mustChangePassword });
    }
    res.redirect(303, '/?notice=password-changed');
  }
}

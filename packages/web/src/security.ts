import {
  ForbiddenException, HttpException, Inject, Injectable, SetMetadata, UnauthorizedException,
  type ArgumentsHost, type CanActivate, type ExceptionFilter, type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConcurrentChange, WorkflowRejected } from '@lis/lab';
import type { NextFunction, Request, Response } from 'express';
import type { Logger } from 'pino';
import { sessionUser, type Role, type SessionPolicy, type SessionUser } from './auth.js';
import type { Db } from '@lis/db';

export const SESSION_COOKIE = 'lims_session';
export const LOGIN_CSRF_COOKIE = 'lims_login_csrf';

export interface WebRequest extends Request {
  user?: SessionUser;
  sessionToken?: string;
}

const PUBLIC = 'lims:public';
const ROLES_KEY = 'lims:roles';
/** The route needs no session (sign-in page, health check). */
export const Public = () => SetMetadata(PUBLIC, true);
/** The signed-in person needs at least one of these roles (10 §2). */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

/** Loads the person behind the session cookie, if any. Runs before the guard. */
export function sessionMiddleware(db: Db, policy: SessionPolicy) {
  return (req: WebRequest, _res: Response, next: NextFunction): void => {
    const token = (req.cookies as Record<string, string | undefined> | undefined)?.[SESSION_COOKIE];
    sessionUser(db, token, policy).then(
      (u) => {
        if (u) {
          req.user = u;
          req.sessionToken = token as string;
        }
        next();
      },
      (e: unknown) => next(e),
    );
  };
}

/**
 * Default deny: every route needs a session unless marked @Public. Every
 * state-changing request must carry the session's CSRF token, and @Roles
 * is checked on every route that declares it.
 */
@Injectable()
export class SecurityGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, targets)) return true;
    const req = ctx.switchToHttp().getRequest<WebRequest>();
    const user = req.user;
    if (!user) throw new UnauthorizedException();
    if (!['GET', 'HEAD'].includes(req.method)) {
      const sent = (req.body as Record<string, unknown> | undefined)?.['_csrf'];
      if (typeof sent !== 'string' || sent !== user.csrfToken) throw new ForbiddenException('The form has expired. Go back, reload the page and try again.');
    }
    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, targets);
    if (roles && !roles.some((r) => user.roles.includes(r))) throw new ForbiddenException('Your account does not have permission for this.');
    return true;
  }
}

/** Security headers for every response (10 §4). No inline script or style is used anywhere. */
export function securityHeaders(secure: boolean) {
  return (_req: Request, res: Response, next: NextFunction): void => {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    if (secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    next();
  };
}

/** Turns errors into pages: sign-in redirect, permission and workflow messages, or a generic error. */
export class PageErrorFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger) {}

  catch(e: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<WebRequest>();
    const res = http.getResponse<Response>();
    if (res.headersSent) return;
    const wantsJson = req.path === '/health' || req.path.startsWith('/api/');
    let status = 500;
    let message = 'Something went wrong. The error has been logged.';
    if (e instanceof UnauthorizedException) {
      if (!wantsJson && req.method === 'GET') return res.redirect(303, `/login?next=${encodeURIComponent(req.originalUrl)}`);
      status = 401;
      message = 'Your session has ended. Sign in again.';
    } else if (e instanceof HttpException) {
      status = e.getStatus();
      const body = e.getResponse();
      message = typeof body === 'string' ? body : status === 404 ? 'Not found.' : ((body as { message?: string }).message ?? e.message);
    } else if (e instanceof WorkflowRejected) {
      status = 409;
      message = e.error.detail;
    } else if (e instanceof ConcurrentChange) {
      status = 409;
      message = 'Someone else changed this result while you were looking at it. Reload and check before trying again.';
    } else {
      this.logger.error({ err: e instanceof Error ? { name: e.name, message: e.message, stack: e.stack } : String(e), path: req.path }, 'request failed');
    }
    if (status >= 500 && e instanceof HttpException) this.logger.error({ status, path: req.path }, 'request failed');
    res.status(status);
    if (wantsJson) {
      res.json({ status, message });
      return;
    }
    res.render('error', { title: 'Error', status, message, user: req.user, csrf: req.user?.csrfToken });
  }
}

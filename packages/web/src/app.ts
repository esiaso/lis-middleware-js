import { isTimeZone } from '@lis/domain';
import { setDisplayTimeZone } from './format.js';
import 'reflect-metadata';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Module, type DynamicModule } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Express } from 'express';
import type { Db } from '@lis/db';
import cookieParser from 'cookie-parser';
import hbs from 'hbs';
import { navCountsMiddleware } from './nav-counts.js';
import { ICON_SPRITE_PATH, iconSprite, iconSvg } from './icons.js';
import { pino, type Logger } from 'pino';
import { DEFAULT_SESSION_POLICY } from './auth.js';
import { AuthController, DashboardController, FailedController, HealthController, ResultsController, UnmatchedController } from './controllers.js';
import { InstrumentsController } from './instruments.controller.js';
import { OrdersController } from './orders.controller.js';
import { DowntimeController } from './downtime.controller.js';
import { AuditController } from './audit.controller.js';
import { AutoverificationController } from './autoverification.controller.js';
import { DeltaController } from './delta.controller.js';
import { OrderReportController } from './order-report.controller.js';
import { PatientsController } from './patients.controller.js';
import { QcController } from './qc.controller.js';
import { ReferenceRangesController } from './reference-ranges.controller.js';
import { StandardCommentsController } from './standard-comments.controller.js';
import { HmisController } from './hmis.controller.js';
import { TranscribeController } from './transcribe.controller.js';
import { CatalogueController, WorksheetController } from './catalogue.controller.js';
import { ReportsController } from './reports.controller.js';
import { CriticalCallController, CriticalController } from './critical.controller.js';
import { AccountController, UsersController } from './users.controller.js';
import { PageErrorFilter, SecurityGuard, securityHeaders, sessionMiddleware } from './security.js';
import { setDirectory } from './ldap.js';
import { Oidc } from './oidc.js';
import { DB, LOGGER, OIDC, WEB_OPTIONS, type WebOptions } from './tokens.js';

const here = dirname(fileURLToPath(import.meta.url));
/** `views` and `public` sit next to `src` and `dist`. */
const pkgRoot = join(here, '..');

@Module({})
class WebModule {
  static with(db: Db, opts: WebOptions, logger: Logger): DynamicModule {
    return {
      module: WebModule,
      controllers: [AuthController, DashboardController, ResultsController, UnmatchedController, FailedController, HmisController, InstrumentsController, OrdersController, DowntimeController, AuditController, CriticalController, CriticalCallController, AutoverificationController, DeltaController, QcController, ReferenceRangesController, StandardCommentsController, CatalogueController, WorksheetController, TranscribeController, PatientsController, OrderReportController, ReportsController, UsersController, AccountController, HealthController],
      providers: [
        { provide: DB, useValue: db },
        { provide: WEB_OPTIONS, useValue: opts },
        { provide: LOGGER, useValue: logger },
        { provide: OIDC, useValue: opts.oidc ? new Oidc(opts.oidc) : null },
        { provide: APP_GUARD, useClass: SecurityGuard },
      ],
    };
  }
}

function viewEngine() {
  const engine = hbs.create();
  const partials = join(pkgRoot, 'views', 'partials');
  for (const f of readdirSync(partials)) if (f.endsWith('.hbs')) engine.registerPartial(basename(f, '.hbs'), readFileSync(join(partials, f), 'utf8'));
  engine.registerHelper('eq', ((a: unknown, b: unknown) => a === b) as never);
  engine.registerHelper('gt', ((a: unknown, b: unknown) => Number(a) > Number(b)) as never);
  engine.registerHelper('icon', ((name: unknown) => new engine.handlebars.SafeString(iconSvg(String(name)))) as never);
  return engine;
}

export interface CreateAppOptions extends Partial<WebOptions> {
  logger?: Logger;
}

/**
 * The web application (09 wireframes). Served on the hospital network only;
 * Bootstrap is served from the installed package, so nothing is fetched from
 * the internet at runtime.
 */
export async function createApp(db: Db, o: CreateAppOptions = {}): Promise<NestExpressApplication> {
  const opts: WebOptions = { twoPersonRule: o.twoPersonRule ?? true, secureCookies: o.secureCookies ?? true, session: o.session ?? DEFAULT_SESSION_POLICY, ...(o.oidc ? { oidc: o.oidc } : {}), ...(o.directory ? { directory: o.directory } : {}), ...(o.reportHeader ? { reportHeader: o.reportHeader } : {}), ...(o.auditSigningKey ? { auditSigningKey: o.auditSigningKey } : {}), timeZone: o.timeZone ?? 'UTC' };
  if (!isTimeZone(opts.timeZone as string)) throw new Error(`LIMS_TIME_ZONE "${String(opts.timeZone).slice(0, 64)}" is not a time zone name such as Africa/Nairobi`);
  setDisplayTimeZone(opts.timeZone as string);
  setDirectory(opts.directory ?? null);
  const logger = o.logger ?? pino({ base: { svc: 'web' } });
  const app = await NestFactory.create<NestExpressApplication>(WebModule.with(db, opts, logger), { logger: false, bodyParser: true });
  const express = app.getHttpAdapter().getInstance() as { disable(name: string): void; set(name: string, v: unknown): void };
  express.disable('x-powered-by');
  // Behind the hospital reverse proxy (11 §4), trust exactly one hop for the client address.
  express.set('trust proxy', 1);
  app.use(securityHeaders(opts.secureCookies));
  app.use(cookieParser());
  app.use(sessionMiddleware(db, opts.session));
  app.use(navCountsMiddleware(db, logger));
  const bootstrapDist = join(dirname(createRequire(import.meta.url).resolve('bootstrap/package.json')), 'dist');
  app.useStaticAssets(join(bootstrapDist, 'css'), { prefix: '/static/bootstrap/', index: false });
  const sprite = iconSprite();
  (app.getHttpAdapter().getInstance() as Express).get(ICON_SPRITE_PATH, (_req, res) => res.type('image/svg+xml').set('Cache-Control', 'public, max-age=3600').send(sprite));
  app.useStaticAssets(join(pkgRoot, 'public'), { prefix: '/static/', index: false });
  app.engine('hbs', viewEngine().__express);
  app.setBaseViewsDir(join(pkgRoot, 'views'));
  app.setViewEngine('hbs');
  app.useGlobalFilters(new PageErrorFilter(logger));
  return app;
}

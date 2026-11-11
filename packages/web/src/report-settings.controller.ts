import { Body, Controller, Get, Inject, NotFoundException, Post, Req, Res } from '@nestjs/common';
import type { Db } from '@lis/db';
import { InvalidInput, LOGO_MAX_BYTES, parseReportHeader, removeReportLogo, reportHeader, reportLogo, saveReportHeader, setReportLogo, type ReportHeaderInput } from '@lis/lab';
import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import { page, requireStepUp, str, type Form } from './controllers.js';
import { formatTime } from './format.js';
import { Roles, type WebRequest } from './security.js';
import { DB, WEB_OPTIONS, type WebOptions } from './tokens.js';

const FIELDS: (keyof ReportHeaderInput)[] = ['labName', 'subtitle', 'address', 'phone', 'email', 'accreditation', 'reportTitle', 'footerNote'];
type Upload = { buffer: Buffer; size: number };
type UploadRequest = Request & { file?: Upload; uploadIssue?: string };

/**
 * Reads the one multipart form (the logo) into memory before the guards run,
 * so the CSRF check sees its fields. A file over the limit is not an error
 * page: it is reported on the form.
 */
export function logoUpload() {
  const single = multer({ storage: multer.memoryStorage(), limits: { fileSize: LOGO_MAX_BYTES, files: 1, fields: 4, fieldSize: 1024, parts: 6 } }).single('logo');
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method !== 'POST') return next();
    single(req, res, (err?: unknown) => {
      if (err) (req as UploadRequest).uploadIssue = (err as { code?: string }).code === 'LIMIT_FILE_SIZE' ? `The logo can be at most ${LOGO_MAX_BYTES / 1024} KB. Save it smaller and try again.` : 'The logo upload could not be read. Try again with one PNG or JPEG file.';
      next();
    });
  };
}

/** The letterhead on printed lab reports (01 A-42, 09 W-26). */
@Controller('settings/report')
export class ReportSettingsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(WEB_OPTIONS) private readonly opts: WebOptions,
  ) {}

  @Get()
  @Roles('admin')
  async show(@Req() req: WebRequest, @Res() res: Response): Promise<void> {
    await this.render(req, res, null, []);
  }

  /** The logo, for any signed-in person, since everyone who prints a report needs it. */
  @Get('logo')
  async logo(@Res() res: Response): Promise<void> {
    const l = await reportLogo(this.db);
    if (!l) throw new NotFoundException();
    res.set('Cache-Control', 'private, max-age=86400').type(l.type).send(l.bytes);
  }

  @Post()
  @Roles('admin')
  async save(@Req() req: WebRequest, @Res() res: Response, @Body() body: Form): Promise<void> {
    const v = Object.fromEntries(FIELDS.map((k) => [k, str(body, k)])) as unknown as ReportHeaderInput;
    const parsed = parseReportHeader(v);
    if (!parsed.ok) return this.render(req, res, v, parsed.issues, 422);
    await requireStepUp(this.db, req, str(body, 'password'));
    await saveReportHeader(this.db, req.user!.username, v);
    res.redirect(303, '/settings/report?notice=report-header-saved');
  }

  @Post('logo')
  @Roles('admin')
  async upload(@Req() req: WebRequest, @Res() res: Response, @Body() body: Form): Promise<void> {
    const r = req as unknown as UploadRequest;
    if (r.uploadIssue) return this.render(req, res, null, [r.uploadIssue], 422);
    if (!r.file) return this.render(req, res, null, ['Choose a logo file to upload.'], 422);
    await requireStepUp(this.db, req, str(body, 'password'));
    try {
      await setReportLogo(this.db, req.user!.username, r.file.buffer);
    } catch (e) {
      if (e instanceof InvalidInput) return this.render(req, res, null, e.issues, 422);
      throw e;
    }
    res.redirect(303, '/settings/report?notice=report-logo-saved');
  }

  @Post('remove-logo')
  @Roles('admin')
  async removeLogo(@Req() req: WebRequest, @Res() res: Response, @Body() body: Form): Promise<void> {
    await requireStepUp(this.db, req, str(body, 'password'));
    await removeReportLogo(this.db, req.user!.username);
    res.redirect(303, '/settings/report?notice=report-logo-removed');
  }

  private async render(req: WebRequest, res: Response, form: ReportHeaderInput | null, issues: string[], status = 200): Promise<void> {
    const h = await reportHeader(this.db);
    const v: ReportHeaderInput = form ?? {
      labName: h?.labName ?? this.opts.reportHeader ?? '',
      subtitle: h?.subtitle ?? '',
      address: h?.addressLines.join('\n') ?? '',
      phone: h?.phone ?? '',
      email: h?.email ?? '',
      accreditation: h?.accreditation ?? '',
      reportTitle: h?.reportTitle ?? 'Laboratory report',
      footerNote: h?.footerNote ?? '',
    };
    res.status(status);
    page(req, res, 'report-settings', {
      title: 'Report header',
      v,
      issues,
      saved: !!h,
      logoVersion: h?.logoVersion ?? null,
      updated: h ? { by: h.updatedBy, at: formatTime(h.updatedAt) } : null,
      fallback: this.opts.reportHeader ?? 'Laboratory report',
      maxKb: LOGO_MAX_BYTES / 1024,
      preview: { ...v, addressLines: v.address.split('\n').map((l) => l.trim()).filter(Boolean), logoVersion: h?.logoVersion ?? null },
    });
  }
}

import { Controller, Get, Inject, Post, Query, Req, Res } from '@nestjs/common';
import type { Db } from '@lis/db';
import { appendAudit, auditExportLine, auditExportTrailer, InvalidInput, verifyAuditChain } from '@lis/lab';
import type { Response } from 'express';
import { page } from './controllers.js';
import { fromZonedLocal } from '@lis/domain';
import { displayTimeZone, formatTime } from './format.js';
import { Roles, type WebRequest } from './security.js';
import { auditSigner } from './audit-signing.js';
import { DB, WEB_OPTIONS, type WebOptions } from './tokens.js';

const PAGE = 100;
/** One export at most; narrow the filters for more (keeps the web process responsive). */
export const EXPORT_LIMIT = 50_000;

export interface AuditFilters {
  entityType: string;
  entityId: string;
  actor: string;
  action: string;
  from: string;
  to: string;
}

function readFilters(q: Record<string, unknown>): AuditFilters {
  const s = (k: string, max: number) => (typeof q[k] === 'string' ? (q[k] as string).trim().slice(0, max) : '');
  return { entityType: s('entityType', 40), entityId: s('entityId', 80), actor: s('actor', 80), action: s('action', 80), from: s('from', 10), to: s('to', 10) };
}

/** Dates are whole days in the lab's time zone (A-24), both ends included. */
function where(f: AuditFilters) {
  const issues: string[] = [];
  const day = (v: string, name: string) => {
    if (!v) return undefined;
    const d = /^\d{4}-\d{2}-\d{2}$/.test(v) ? fromZonedLocal(v, displayTimeZone()) : null;
    if (!d) issues.push(`${name} must be a date.`);
    return d ?? undefined;
  };
  const from = day(f.from, 'From');
  // The end of the last day is the start of the next one, on the lab's clock.
  const next = /^\d{4}-\d{2}-\d{2}$/.test(f.to) ? new Date(Date.parse(`${f.to}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10) : f.to;
  const to = f.to ? day(next, 'To') : undefined;
  if (issues.length) throw new InvalidInput(issues);
  return {
    ...(f.entityType ? { entityType: f.entityType } : {}),
    ...(f.entityId ? { entityId: f.entityId } : {}),
    ...(f.actor ? { actor: f.actor } : {}),
    // "result." finds every result action; a full name finds just that one.
    ...(f.action ? { action: f.action.endsWith('.') ? { startsWith: f.action } : f.action } : {}),
    ...(from || to ? { at: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } } : {}),
  };
}

const short = (v: unknown) => {
  if (v === null || v === undefined) return '';
  const s = JSON.stringify(v);
  return s.length > 160 ? `${s.slice(0, 157)}...` : s;
};

/** W-10 audit search and export (10 §8). Auditors only (10 §2). */
@Controller('audit')
export class AuditController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(WEB_OPTIONS) private readonly opts: WebOptions,
  ) {}

  /** What the page says about signing; a key that cannot be used is shown, not hidden. */
  private signing(): { keyId: string } | { error: string } | null {
    try {
      const s = auditSigner(this.opts.auditSigningKey);
      return s ? { keyId: s.keyId } : null;
    } catch (e) {
      return { error: (e as Error).message };
    }
  }

  @Get()
  @Roles('auditor')
  async search(@Req() req: WebRequest, @Res() res: Response, @Query() q: Record<string, unknown>): Promise<void> {
    const f = readFilters(q);
    const before = typeof q['before'] === 'string' && /^\d{1,19}$/.test(q['before']) ? BigInt(q['before']) : undefined;
    const w = where(f);
    const [rows, total, types, lastCheck] = await Promise.all([
      this.db.auditEvent.findMany({ where: { ...w, ...(before !== undefined ? { seq: { lt: before } } : {}) }, orderBy: { seq: 'desc' }, take: PAGE + 1 }),
      this.db.auditEvent.count({ where: w }),
      this.db.auditEvent.findMany({ distinct: ['entityType'], select: { entityType: true }, orderBy: { entityType: 'asc' } }),
      this.db.auditEvent.findFirst({ where: { action: 'audit.chain-verified' }, orderBy: { seq: 'desc' } }),
    ]);
    const more = rows.length > PAGE;
    const shown = rows.slice(0, PAGE);
    const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v) as [string, string][]);
    const check = lastCheck?.after as { ok?: boolean; count?: number; brokenAtSeq?: string } | null | undefined;
    page(req, res, 'audit', {
      title: 'Audit',
      f,
      total,
      types: types.map((t) => ({ value: t.entityType, selected: t.entityType === f.entityType })),
      rows: shown.map((r) => ({
        seq: String(r.seq),
        at: formatTime(r.at),
        actor: r.actor,
        action: r.action,
        entity: `${r.entityType} ${r.entityId}`,
        reason: r.reason ?? '',
        correlationId: r.correlationId ?? '',
        before: short(r.before),
        after: short(r.after),
      })),
      next: more ? `/audit?${new URLSearchParams([...qs, ['before', String(shown[shown.length - 1]!.seq)]])}` : '',
      exportHref: `/audit/export${qs.size ? `?${qs}` : ''}`,
      signing: this.signing(),
      check: lastCheck ? { at: formatTime(lastCheck.at), by: lastCheck.actor, ok: check?.ok === true, count: check?.count ?? 0, brokenAtSeq: check?.brokenAtSeq ?? '' } : null,
    });
  }

  /**
   * JSON lines, oldest first, each event with its prev_hash and hash so a
   * contiguous range can be checked by anyone, then a manifest, then an
   * Ed25519 signature line when the hospital has set a signing key (A-16,
   * 10 §8; format in @lis/lab audit-export).
   */
  @Get('export')
  @Roles('auditor')
  async export(@Req() req: WebRequest, @Res() res: Response, @Query() q: Record<string, unknown>): Promise<void> {
    const f = readFilters(q);
    const w = where(f);
    const total = await this.db.auditEvent.count({ where: w });
    // Before anything is recorded: a key that is set but unusable refuses the export.
    const signer = auditSigner(this.opts.auditSigningKey);
    if (total > EXPORT_LIMIT) throw new InvalidInput([`${total} events match; one export holds at most ${EXPORT_LIMIT}. Narrow the dates or filters.`]);
    const exportedAt = new Date();
    // Recorded before the file is built, so the export itself is in the trail it may later be compared with.
    await this.db.$transaction((tx) => appendAudit(tx, { actor: req.user!.username, action: 'audit.export', entityType: 'audit', entityId: 'export', after: { filters: f, count: total, signed: signer !== null, ...(signer ? { keyId: signer.keyId } : {}) } }));
    const lines: string[] = [];
    let cursor: bigint | undefined;
    for (;;) {
      const batch = await this.db.auditEvent.findMany({ where: { ...w, ...(cursor !== undefined ? { seq: { gt: cursor } } : {}) }, orderBy: { seq: 'asc' }, take: 1000 });
      if (batch.length === 0) break;
      for (const r of batch) {
        if (lines.length >= total) break; // events written after the count belong to the next export
        lines.push(auditExportLine(r));
      }
      cursor = batch[batch.length - 1]!.seq;
      if (lines.length >= total) break;
    }
    const trailer = auditExportTrailer(lines, { exportedAt, exportedBy: req.user!.username, filters: f }, signer);
    const stamp = exportedAt.toISOString().replace(/[-:]/g, '').slice(0, 15);
    res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="audit-${stamp}Z.jsonl"`);
    res.setHeader('cache-control', 'no-store');
    res.send(lines.join('') + trailer);
  }

  /** The public half of the signing key, for whoever checks exports. It is not a secret. */
  @Get('signing-key.pem')
  @Roles('auditor')
  signingKey(@Res() res: Response): void {
    const signer = auditSigner(this.opts.auditSigningKey);
    if (!signer) {
      res.status(404).type('text/plain').send('no audit signing key is set\n');
      return;
    }
    res.setHeader('content-type', 'application/x-pem-file');
    res.setHeader('content-disposition', `attachment; filename="lims-audit-${signer.keyId}.pem"`);
    res.send(signer.publicKeyPem);
  }

  /** Recompute the whole chain now and record the outcome (the nightly job does the same). */
  @Post('verify')
  @Roles('auditor')
  async verify(@Req() req: WebRequest, @Res() res: Response): Promise<void> {
    const r = await verifyAuditChain(this.db);
    const after = r.ok ? { ok: true, count: r.count, head: r.head } : { ok: false, brokenAtSeq: String(r.brokenAtSeq) };
    await this.db.$transaction((tx) => appendAudit(tx, { actor: req.user!.username, action: 'audit.chain-verified', entityType: 'audit', entityId: 'chain', after }));
    res.redirect(303, r.ok ? '/audit?notice=chain-ok' : '/audit');
  }
}

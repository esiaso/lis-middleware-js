import { createHash } from 'node:crypto';
import { Controller, Get, Inject, Post, Query, Req, Res } from '@nestjs/common';
import type { Db } from '@lis/db';
import { appendAudit, InvalidInput, verifyAuditChain } from '@lis/lab';
import type { Response } from 'express';
import { page } from './controllers.js';
import { fromZonedLocal } from '@lis/domain';
import { displayTimeZone, formatTime } from './format.js';
import { Roles, type WebRequest } from './security.js';
import { DB } from './tokens.js';

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
  constructor(@Inject(DB) private readonly db: Db) {}

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
      check: lastCheck ? { at: formatTime(lastCheck.at), by: lastCheck.actor, ok: check?.ok === true, count: check?.count ?? 0, brokenAtSeq: check?.brokenAtSeq ?? '' } : null,
    });
  }

  /**
   * JSON lines, oldest first, each event with its prev_hash and hash so a
   * contiguous range can be checked by anyone. The last line is a manifest
   * with the SHA-256 of all the lines before it. ASSUMPTION A-16: not signed
   * yet; signing needs a key the hospital holds (10 §8).
   */
  @Get('export')
  @Roles('auditor')
  async export(@Req() req: WebRequest, @Res() res: Response, @Query() q: Record<string, unknown>): Promise<void> {
    const f = readFilters(q);
    const w = where(f);
    const total = await this.db.auditEvent.count({ where: w });
    if (total > EXPORT_LIMIT) throw new InvalidInput([`${total} events match; one export holds at most ${EXPORT_LIMIT}. Narrow the dates or filters.`]);
    const exportedAt = new Date();
    // Recorded before the file is built, so the export itself is in the trail it may later be compared with.
    await this.db.$transaction((tx) => appendAudit(tx, { actor: req.user!.username, action: 'audit.export', entityType: 'audit', entityId: 'export', after: { filters: f, count: total } }));
    const hash = createHash('sha256');
    const lines: string[] = [];
    let cursor: bigint | undefined;
    let first: string | null = null;
    let last: string | null = null;
    for (;;) {
      const batch = await this.db.auditEvent.findMany({ where: { ...w, ...(cursor !== undefined ? { seq: { gt: cursor } } : {}) }, orderBy: { seq: 'asc' }, take: 1000 });
      if (batch.length === 0) break;
      for (const r of batch) {
        if (lines.length >= total) break; // events written after the count belong to the next export
        const line = JSON.stringify({
          seq: String(r.seq), id: r.id, at: r.at.toISOString(), actor: r.actor, action: r.action, entityType: r.entityType, entityId: r.entityId,
          reason: r.reason, correlationId: r.correlationId, before: r.before, after: r.after, prevHash: r.prevHash, hash: r.hash,
        }) + '\n';
        hash.update(line);
        lines.push(line);
        first ??= String(r.seq);
        last = String(r.seq);
      }
      cursor = batch[batch.length - 1]!.seq;
      if (lines.length >= total) break;
    }
    const manifest = {
      type: 'manifest',
      format: 'lims-audit-export/1',
      exportedAt: exportedAt.toISOString(),
      exportedBy: req.user!.username,
      filters: f,
      count: lines.length,
      firstSeq: first,
      lastSeq: last,
      sha256: hash.digest('hex'),
      signed: false,
    };
    const stamp = exportedAt.toISOString().replace(/[-:]/g, '').slice(0, 15);
    res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="audit-${stamp}Z.jsonl"`);
    res.setHeader('cache-control', 'no-store');
    res.send(lines.join('') + JSON.stringify(manifest) + '\n');
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

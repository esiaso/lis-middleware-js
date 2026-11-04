import { uuidv7, type Db } from '@lis/db';
import { appendAudit } from './audit.js';
import { InvalidInput } from './instruments.js';
import { WorkflowRejected } from './results.js';
import type { Tx } from './tx.js';

/**
 * Comments on results (01 A-26). Free text from lab staff, either for the
 * lab only or printed on the result report under the value. A comment is
 * never edited or deleted (a database trigger enforces it); a wrong one is
 * withdrawn with a reason and stays in the history. Comments are not sent
 * to the HMIS: its format for them is not known (D-1 to D-6).
 */
export function parseComment(text: string): string {
  // Collapse runs of whitespace so a report line cannot be padded out; no control characters.
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length < 2 || t.length > 500) throw new InvalidInput(['A comment is 2 to 500 characters.']);
  return t;
}

/**
 * Adds a comment, typed or picked from the lab's standard comments (A-27).
 * A standard comment's text is copied in, so retiring or replacing it later
 * never changes a comment already made; the audit records its code.
 */
export async function addResultComment(db: Db, resultId: string, actor: string, input: { text: string; onReport: boolean; standardId?: string }): Promise<string> {
  const typed = input.text.trim();
  if (input.standardId && typed) throw new InvalidInput(['Pick a standard comment or type one, not both.']);
  const id = uuidv7();
  await db.$transaction(async (tx) => {
    const r = await tx.result.findUnique({ where: { id: resultId }, select: { id: true, orderedTest: { select: { localTestCode: true } } } });
    if (!r) throw new WorkflowRejected({ code: 'INVALID_STATE', detail: 'no such result' });
    let text: string;
    let standardCode: string | null = null;
    if (input.standardId) {
      const sc = await tx.standardComment.findUnique({ where: { id: input.standardId } });
      if (!sc || !sc.active || (sc.localTestCode !== null && sc.localTestCode !== r.orderedTest.localTestCode)) throw new InvalidInput(['That standard comment is not offered for this test any more.']);
      text = sc.text;
      standardCode = sc.code;
    } else {
      text = parseComment(input.text);
    }
    await tx.resultComment.create({ data: { id, resultId, text, onReport: input.onReport, createdBy: actor } });
    await appendAudit(tx, { actor, action: 'result.comment', entityType: 'result', entityId: resultId, after: { commentId: id, text, onReport: input.onReport, ...(standardCode ? { standardCode } : {}) } });
  });
  return id;
}

export interface StandardCommentInput {
  code: string;
  text: string;
  /** Empty for every test. */
  localTestCode: string;
}

export function parseStandardComment(input: StandardCommentInput): { ok: true; value: { code: string; text: string; localTestCode: string | null } } | { ok: false; issues: string[] } {
  const code = input.code.trim().toUpperCase();
  const issues: string[] = [];
  if (!/^[A-Z0-9][A-Z0-9-]{1,11}$/.test(code)) issues.push('The code is 2 to 12 letters, digits or hyphens, such as HAEM.');
  let text = '';
  try {
    text = parseComment(input.text);
  } catch (e) {
    if (e instanceof InvalidInput) issues.push(...e.issues);
    else throw e;
  }
  if (issues.length) return { ok: false, issues };
  return { ok: true, value: { code, text, localTestCode: input.localTestCode.trim() || null } };
}

export async function addStandardComment(db: Db, actor: string, input: StandardCommentInput): Promise<string> {
  const p = parseStandardComment(input);
  if (!p.ok) throw new InvalidInput(p.issues);
  const id = uuidv7();
  await db.$transaction(async (tx) => {
    if (await tx.standardComment.findFirst({ where: { code: p.value.code, active: true } })) throw new InvalidInput([`The code ${p.value.code} is already in use. Retire that comment first.`]);
    await tx.standardComment.create({ data: { id, ...p.value, createdBy: actor } });
    await appendAudit(tx, { actor, action: 'standard-comment.add', entityType: 'standard_comment', entityId: id, after: p.value });
  });
  return id;
}

export async function retireStandardComment(db: Db, actor: string, id: string, reason: string): Promise<void> {
  if (reason.trim().length < 5) throw new InvalidInput(['Give a reason of at least 5 characters.']);
  await db.$transaction(async (tx) => {
    const n = await tx.standardComment.updateMany({ where: { id, active: true }, data: { active: false, retiredBy: actor, retiredAt: new Date(), retireReason: reason.trim() } });
    if (n.count !== 1) throw new WorkflowRejected({ code: 'INVALID_STATE', detail: 'that standard comment is not active' });
    await appendAudit(tx, { actor, action: 'standard-comment.retire', entityType: 'standard_comment', entityId: id, reason: reason.trim() });
  });
}

/** Active standard comments offered on a result of this test, by code. */
export async function standardCommentsFor(db: Db | Tx, localTestCode: string | null) {
  return db.standardComment.findMany({
    where: { active: true, OR: [{ localTestCode: null }, ...(localTestCode ? [{ localTestCode }] : [])] },
    orderBy: { code: 'asc' },
  });
}

export async function withdrawResultComment(db: Db, commentId: string, actor: string, reason: string): Promise<string> {
  if (reason.trim().length < 5) throw new InvalidInput(['Give a reason of at least 5 characters.']);
  return db.$transaction(async (tx) => {
    const c = await tx.resultComment.findUnique({ where: { id: commentId } });
    if (!c || c.withdrawnAt) throw new WorkflowRejected({ code: 'INVALID_STATE', detail: 'that comment is already withdrawn' });
    await tx.resultComment.update({ where: { id: commentId }, data: { withdrawnBy: actor, withdrawnAt: new Date(), withdrawReason: reason.trim() } });
    await appendAudit(tx, { actor, action: 'result.comment-withdrawn', entityType: 'result', entityId: c.resultId, reason: reason.trim(), before: { commentId, text: c.text, onReport: c.onReport } });
    return c.resultId;
  });
}

/** Comments that print on the report, oldest first. */
export async function reportComments(db: Db | Tx, resultIds: string[]): Promise<Map<string, string[]>> {
  const rows = resultIds.length ? await db.resultComment.findMany({ where: { resultId: { in: resultIds }, onReport: true, withdrawnAt: null }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }) : [];
  const out = new Map<string, string[]>();
  for (const r of rows) out.set(r.resultId, [...(out.get(r.resultId) ?? []), r.text]);
  return out;
}

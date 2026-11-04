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

export async function addResultComment(db: Db, resultId: string, actor: string, input: { text: string; onReport: boolean }): Promise<string> {
  const text = parseComment(input.text);
  const id = uuidv7();
  await db.$transaction(async (tx) => {
    if (!(await tx.result.findUnique({ where: { id: resultId }, select: { id: true } }))) throw new WorkflowRejected({ code: 'INVALID_STATE', detail: 'no such result' });
    await tx.resultComment.create({ data: { id, resultId, text, onReport: input.onReport, createdBy: actor } });
    await appendAudit(tx, { actor, action: 'result.comment', entityType: 'result', entityId: resultId, after: { commentId: id, text, onReport: input.onReport } });
  });
  return id;
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

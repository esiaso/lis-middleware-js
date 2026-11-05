import { uuidv7, type Db, type JsonInput } from '@lis/db';
import { parseCatalogueForm, type CatalogueAnswer, type CatalogueDefinition, type CatalogueForm, type CatalogueResultType, type PerformedBy } from '@lis/domain';
import { appendAudit } from './audit.js';
import { InvalidInput } from './instruments.js';
import { WorkflowRejected } from './results.js';
import type { Tx } from './tx.js';

/**
 * The lab's own test catalogue (design: "Test catalogue and LOINC"). A change
 * is proposed as a DRAFT version; a different person makes it ACTIVE, which
 * retires the version before it. Results keep the code they were made with,
 * so a later change never rewrites a released result.
 */

type Row = Awaited<ReturnType<Db['testCatalogueEntry']['findFirstOrThrow']>>;

export interface CatalogueEntry extends CatalogueDefinition {
  id: string;
  versionNo: number;
  status: 'DRAFT' | 'ACTIVE' | 'RETIRED' | 'DISCARDED';
  changeReason: string;
  createdBy: string;
  createdAt: Date;
  approvedBy?: string;
  approvedAt?: Date;
}

export function toEntry(r: Row): CatalogueEntry {
  return {
    id: r.id,
    versionNo: r.versionNo,
    status: r.status as CatalogueEntry['status'],
    localCode: r.localCode,
    name: r.name,
    section: r.section,
    ...(r.loincCode ? { loincCode: r.loincCode } : {}),
    ...(r.loincDisplay ? { loincDisplay: r.loincDisplay } : {}),
    ...(r.shaCode ? { shaCode: r.shaCode } : {}),
    ...(r.specimenType ? { specimenType: r.specimenType } : {}),
    performedBy: r.performedBy as PerformedBy,
    resultType: r.resultType as CatalogueResultType,
    answers: r.answers as unknown as CatalogueAnswer[],
    ...(r.unit ? { unit: r.unit } : {}),
    ...(r.decimals !== null ? { decimals: r.decimals } : {}),
    ...(r.resultType === 'PANEL' ? { components: r.components as unknown as string[] } : {}),
    ...(r.qcRule === 'WARN' || r.qcRule === 'BLOCK' ? { qcRule: r.qcRule } : {}),
    ...(r.qcValidHours !== null ? { qcValidHours: r.qcValidHours } : {}),
    changeReason: r.changeReason,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
    ...(r.approvedBy ? { approvedBy: r.approvedBy } : {}),
    ...(r.approvedAt ? { approvedAt: r.approvedAt } : {}),
  };
}

/** The active version of every test, by local code. */
export async function activeCatalogue(db: Db | Tx): Promise<CatalogueEntry[]> {
  return (await db.testCatalogueEntry.findMany({ where: { status: 'ACTIVE' }, orderBy: [{ section: 'asc' }, { localCode: 'asc' }] })).map(toEntry);
}

export async function activeEntry(db: Db | Tx, localCode: string): Promise<CatalogueEntry | null> {
  const r = await db.testCatalogueEntry.findFirst({ where: { localCode, status: 'ACTIVE' } });
  return r ? toEntry(r) : null;
}

/** Drafts waiting for a second person. */
export async function catalogueDrafts(db: Db | Tx): Promise<CatalogueEntry[]> {
  return (await db.testCatalogueEntry.findMany({ where: { status: 'DRAFT' }, orderBy: { createdAt: 'asc' } })).map(toEntry);
}

export async function catalogueHistory(db: Db | Tx, localCode: string): Promise<CatalogueEntry[]> {
  return (await db.testCatalogueEntry.findMany({ where: { localCode }, orderBy: { versionNo: 'desc' } })).map(toEntry);
}

/** Propose a new test, or a change to one, as a draft. */
export async function proposeCatalogueEntry(db: Db, actor: string, form: CatalogueForm, reason: string): Promise<CatalogueEntry> {
  const p = parseCatalogueForm(form);
  const issues = p.ok ? [] : [...p.issues];
  if (reason.trim().length < 5) issues.push('Say why, in at least 5 characters (for example "new test from the HMIS catalogue").');
  if (!p.ok || issues.length) throw new InvalidInput(issues);
  const d = p.value;
  return db.$transaction(async (tx) => {
    await checkComponents(tx, d);
    if (await tx.testCatalogueEntry.findFirst({ where: { localCode: d.localCode, status: 'DRAFT' } })) {
      throw new InvalidInput([`${d.localCode} already has a change waiting for approval. Approve or discard it first.`]);
    }
    const last = await tx.testCatalogueEntry.findFirst({ where: { localCode: d.localCode }, orderBy: { versionNo: 'desc' } });
    const row = await tx.testCatalogueEntry.create({
      data: {
        id: uuidv7(),
        localCode: d.localCode,
        versionNo: (last?.versionNo ?? 0) + 1,
        status: 'DRAFT',
        name: d.name,
        section: d.section,
        loincCode: d.loincCode ?? null,
        loincDisplay: d.loincDisplay ?? null,
        shaCode: d.shaCode ?? null,
        specimenType: d.specimenType ?? null,
        performedBy: d.performedBy,
        resultType: d.resultType,
        answers: d.answers as unknown as JsonInput,
        unit: d.unit ?? null,
        decimals: d.decimals ?? null,
        components: (d.components ?? []) as unknown as JsonInput,
        qcRule: d.qcRule ?? 'NONE',
        qcValidHours: d.qcValidHours ?? null,
        changeReason: reason.trim(),
        createdBy: actor,
      },
    });
    await appendAudit(tx, { actor, action: 'catalogue.propose', entityType: 'test_catalogue', entityId: row.id, reason: reason.trim(), after: { ...d, versionNo: row.versionNo } as unknown as Record<string, unknown> });
    return toEntry(row);
  });
}

/**
 * A second person makes a draft the active version. Its LOINC code is added
 * to the HMIS code map, so HMIS orders for that code reach this test; a LOINC
 * code already mapped to another test is refused rather than moved.
 */
export async function approveCatalogueEntry(db: Db, actor: string, id: string): Promise<CatalogueEntry> {
  return db.$transaction(async (tx) => {
    const draft = await tx.testCatalogueEntry.findUnique({ where: { id } });
    if (!draft || draft.status !== 'DRAFT') throw new WorkflowRejected({ code: 'INVALID_STATE', detail: 'only a draft waiting for approval can be approved' });
    if (draft.createdBy === actor) throw new WorkflowRejected({ code: 'SAME_PERSON', detail: 'a catalogue change is approved by someone other than the person who proposed it' });
    await checkComponents(tx, toEntry(draft));
    if (draft.loincCode) {
      const mapped = await tx.hmisCodeMap.findUnique({ where: { hmisTestCode: draft.loincCode } });
      if (mapped && mapped.localTestCode !== draft.localCode) {
        throw new InvalidInput([`LOINC ${draft.loincCode} already brings HMIS orders to ${mapped.localTestCode}. Change that test first, or check the code.`]);
      }
      if (!mapped) {
        await tx.hmisCodeMap.create({ data: { hmisTestCode: draft.loincCode, localTestCode: draft.localCode } });
        await appendAudit(tx, { actor, action: 'hmis-code-map.add', entityType: 'hmis_code_map', entityId: draft.loincCode, after: { hmisTestCode: draft.loincCode, localTestCode: draft.localCode } });
      }
    }
    const now = new Date();
    const previous = await tx.testCatalogueEntry.findFirst({ where: { localCode: draft.localCode, status: 'ACTIVE' } });
    if (previous) {
      await tx.testCatalogueEntry.update({ where: { id: previous.id }, data: { status: 'RETIRED', retiredBy: actor, retiredAt: now, retireReason: `replaced by version ${draft.versionNo}` } });
    }
    const row = await tx.testCatalogueEntry.update({ where: { id }, data: { status: 'ACTIVE', approvedBy: actor, approvedAt: now } });
    await appendAudit(tx, {
      actor,
      action: 'catalogue.approve',
      entityType: 'test_catalogue',
      entityId: id,
      before: previous ? { versionNo: previous.versionNo, status: 'ACTIVE' } : {},
      after: { localCode: row.localCode, versionNo: row.versionNo, status: 'ACTIVE' },
    });
    return toEntry(row);
  });
}

/** Drop a draft without making it active. */
export async function discardCatalogueDraft(db: Db, actor: string, id: string, reason: string): Promise<void> {
  if (reason.trim().length < 5) throw new InvalidInput(['Give a reason of at least 5 characters.']);
  await db.$transaction(async (tx) => {
    const n = await tx.testCatalogueEntry.updateMany({ where: { id, status: 'DRAFT' }, data: { status: 'DISCARDED', retiredBy: actor, retiredAt: new Date(), retireReason: reason.trim() } });
    if (n.count !== 1) throw new WorkflowRejected({ code: 'INVALID_STATE', detail: 'only a draft can be discarded' });
    await appendAudit(tx, { actor, action: 'catalogue.discard', entityType: 'test_catalogue', entityId: id, reason: reason.trim() });
  });
}

/** Stop offering a test. Results already made keep it; its HMIS code map stays so old orders still read. */
export async function retireCatalogueEntry(db: Db, actor: string, localCode: string, reason: string): Promise<void> {
  if (reason.trim().length < 5) throw new InvalidInput(['Give a reason of at least 5 characters.']);
  await db.$transaction(async (tx) => {
    const active = await tx.testCatalogueEntry.findFirst({ where: { localCode, status: 'ACTIVE' } });
    if (!active) throw new WorkflowRejected({ code: 'INVALID_STATE', detail: `${localCode} has no active version` });
    const using = await panelsUsing(tx, localCode);
    if (using.length) throw new InvalidInput([`${localCode} is a component of ${using.join(', ')}. Change or retire the panel first.`]);
    await tx.testCatalogueEntry.update({ where: { id: active.id }, data: { status: 'RETIRED', retiredBy: actor, retiredAt: new Date(), retireReason: reason.trim() } });
    await appendAudit(tx, { actor, action: 'catalogue.retire', entityType: 'test_catalogue', entityId: active.id, reason: reason.trim(), before: { localCode, versionNo: active.versionNo, status: 'ACTIVE' } });
  });
}

/** Panels in use that list this test as a component. */
async function panelsUsing(tx: Tx, localCode: string): Promise<string[]> {
  const panels = await tx.testCatalogueEntry.findMany({ where: { status: 'ACTIVE', resultType: 'PANEL' } });
  return panels.filter((e) => e.localCode !== localCode && (e.components as unknown as string[]).includes(localCode)).map((e) => e.localCode);
}

/** A panel's components must each be an active test that is not itself a panel; a component cannot become a panel. */
async function checkComponents(tx: Tx, d: CatalogueDefinition): Promise<void> {
  if (d.resultType !== 'PANEL') return;
  const issues: string[] = [];
  const using = await panelsUsing(tx, d.localCode);
  if (using.length) issues.push(`${d.localCode} is a component of ${using.join(', ')}, so it cannot be a panel itself.`);
  const found = await tx.testCatalogueEntry.findMany({ where: { localCode: { in: d.components ?? [] }, status: 'ACTIVE' } });
  const byCode = new Map(found.map((e) => [e.localCode, e]));
  const missing = (d.components ?? []).filter((c) => !byCode.has(c));
  const nested = found.filter((e) => e.resultType === 'PANEL').map((e) => e.localCode);
  if (missing.length) issues.push(`Add these tests to the catalogue before the panel: ${missing.join(', ')}.`);
  if (nested.length) issues.push(`A panel cannot contain another panel: ${nested.join(', ')}.`);
  if (issues.length) throw new InvalidInput(issues);
}

export interface ExpandedTest {
  localTestCode: string | null;
  /** '' for an ordinary test. */
  componentCode: string;
  panelCode: string | null;
}

/** What one ordered code becomes: its components for an active panel, otherwise the test itself. */
export async function expandTest(tx: Db | Tx, localCode: string | null): Promise<ExpandedTest[]> {
  if (!localCode) return [{ localTestCode: null, componentCode: '', panelCode: null }];
  const e = await tx.testCatalogueEntry.findFirst({ where: { localCode, status: 'ACTIVE' } });
  if (!e || e.resultType !== 'PANEL') return [{ localTestCode: localCode, componentCode: '', panelCode: null }];
  return (e.components as unknown as string[]).map((c) => ({ localTestCode: c, componentCode: c, panelCode: localCode }));
}

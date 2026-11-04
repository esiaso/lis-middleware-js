import {
  InstrumentConnectionConfig, InstrumentRegistration, TestMapping, TestMappingSet, VerificationEvidence,
  type InstrumentState, type MappingSetStatus, type VerificationStatus,
} from '@lis/contracts';
import { uuidv7, type Db, type JsonInput } from '@lis/db';
import {
  activate as activateMappings, applyEvidence, approve as approveMappings, changeRegistration, registerInstrument,
} from '@lis/domain';
import { z } from 'zod';
import { appendAudit } from './audit.js';
import { ConcurrentChange, WorkflowRejected } from './results.js';
import type { Tx } from './tx.js';

/**
 * Instrument registration, verification evidence, enable/disable and
 * versioned test mappings (14 §3), persisted with their audit events.
 * The rules themselves live in @lis/domain; this file only stores them.
 */

/** Input that did not pass the contract. `issues` are "path: message" lines, without values. */
export class InvalidInput extends Error {
  constructor(readonly issues: string[]) {
    super(issues.join('; '));
    this.name = 'InvalidInput';
  }
}

function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const r = schema.safeParse(input);
  if (!r.success) throw new InvalidInput(r.error.issues.map((i) => `${i.path.join('.') || '(form)'}: ${i.message}`));
  return r.data;
}

const toDb = (s: VerificationStatus) => s.toUpperCase() as 'UNVERIFIED' | 'VENDOR_TESTED' | 'LAB_ACCEPTED' | 'SUSPENDED';
const fromDb = (s: string) => s.toLowerCase() as VerificationStatus;

async function activeConnection(tx: Tx | Db, instrumentId: string, at = new Date()) {
  return tx.instrumentConnection.findFirst({
    where: { instrumentId, activeFrom: { lte: at }, OR: [{ activeTo: null }, { activeTo: { gt: at } }] },
    orderBy: { activeFrom: 'desc' },
  });
}

export interface LoadedInstrument {
  state: InstrumentState;
  rowVersion: number;
}

/** Rebuild the domain state from the instrument row and its active connection. */
export async function loadInstrument(tx: Tx | Db, instrumentId: string): Promise<LoadedInstrument> {
  const i = await tx.instrument.findUnique({ where: { id: instrumentId } });
  if (!i) throw new WorkflowRejected({ code: 'INVALID_STATE', detail: `instrument ${instrumentId} is not registered` });
  const conn = await activeConnection(tx, instrumentId);
  if (!conn) throw new WorkflowRejected({ code: 'INVALID_STATE', detail: `instrument ${instrumentId} has no active connection configuration` });
  const registration = InstrumentRegistration.parse({
    instrumentId: i.id,
    displayName: i.displayName,
    manufacturer: i.manufacturer,
    model: i.model,
    discipline: i.discipline,
    connection: InstrumentConnectionConfig.parse(conn.configJson),
    ...(i.serialNo ? { serialNo: i.serialNo } : {}),
    ...(i.softwareVersion ? { softwareVersion: i.softwareVersion } : {}),
    ...(i.location ? { location: i.location } : {}),
    ...(i.interfaceManualRef ? { interfaceManualRef: i.interfaceManualRef } : {}),
  });
  const state: InstrumentState = { registration, verificationStatus: fromDb(i.verificationStatus), enabled: i.enabled };
  if (i.verifiedSoftwareVersion) state.verifiedSoftwareVersion = i.verifiedSoftwareVersion;
  return { state, rowVersion: i.version };
}

const identity = (r: InstrumentRegistration) => ({
  displayName: r.displayName,
  manufacturer: r.manufacturer,
  model: r.model,
  discipline: r.discipline,
  serialNo: r.serialNo ?? null,
  softwareVersion: r.softwareVersion ?? null,
  location: r.location ?? null,
  interfaceManualRef: r.interfaceManualRef ?? null,
});

/** Register a new instrument: always UNVERIFIED and disabled (14 §3 rule 1). */
export async function registerInstrumentRecord(db: Db, input: unknown, actor: string): Promise<string> {
  const reg = parse(InstrumentRegistration, input);
  const state = registerInstrument(reg);
  await db.$transaction(async (tx) => {
    if (await tx.instrument.findUnique({ where: { id: reg.instrumentId } })) throw new InvalidInput([`instrumentId: ${reg.instrumentId} is already registered`]);
    await tx.instrument.create({ data: { id: reg.instrumentId, ...identity(reg), verificationStatus: toDb(state.verificationStatus), enabled: false, createdBy: actor } });
    await tx.instrumentConnection.create({ data: { id: uuidv7(), instrumentId: reg.instrumentId, configJson: reg.connection as unknown as JsonInput, activeFrom: new Date(), createdBy: actor } });
    await appendAudit(tx, { actor, action: 'instrument.register', entityType: 'instrument', entityId: reg.instrumentId, after: reg });
  });
  return reg.instrumentId;
}

export interface RegistrationChangeReport {
  resetReasons: string[];
  retestReasons: string[];
}

/**
 * Change a registration. Identity, driver or profile changes reset the
 * status to UNVERIFIED (rule 4). The old connection row is closed, not
 * edited, so messages received earlier are still decoded with the
 * configuration that was active when they arrived.
 */
export async function changeInstrumentRegistration(db: Db, instrumentId: string, input: unknown, expectedVersion: number, actor: string): Promise<RegistrationChangeReport> {
  const next = parse(InstrumentRegistration, input);
  if (next.instrumentId !== instrumentId) throw new InvalidInput(['instrumentId: cannot change; register a new instrument']);
  return db.$transaction(async (tx) => {
    const before = await loadInstrument(tx, instrumentId);
    if (before.rowVersion !== expectedVersion) throw new ConcurrentChange(instrumentId);
    const out = changeRegistration(before.state, next);
    const n = await tx.instrument.updateMany({
      where: { id: instrumentId, version: expectedVersion },
      data: {
        ...identity(next),
        verificationStatus: toDb(out.state.verificationStatus),
        verifiedSoftwareVersion: out.state.verifiedSoftwareVersion ?? null,
        // A reset also takes the instrument out of service until it is accepted again.
        enabled: out.resetReasons.length > 0 ? false : out.state.enabled,
        version: { increment: 1 },
      },
    });
    if (n.count !== 1) throw new ConcurrentChange(instrumentId);
    const connChanged = JSON.stringify(before.state.registration.connection) !== JSON.stringify(next.connection);
    if (connChanged) {
      const now = new Date();
      await tx.instrumentConnection.updateMany({ where: { instrumentId, activeTo: null }, data: { activeTo: now } });
      await tx.instrumentConnection.create({ data: { id: uuidv7(), instrumentId, configJson: next.connection as unknown as JsonInput, activeFrom: now, createdBy: actor } });
    }
    await appendAudit(tx, {
      actor,
      action: 'instrument.change',
      entityType: 'instrument',
      entityId: instrumentId,
      ...(out.resetReasons.length ? { reason: `reset to unverified: ${out.resetReasons.join(', ')}` } : {}),
      before: before.state,
      after: { ...out.state, retestReasons: out.retestReasons },
    });
    return { resetReasons: out.resetReasons, retestReasons: out.retestReasons };
  });
}

/** Record interface test, lab acceptance, suspension or re-verification (rule 3). */
export async function recordInstrumentEvidence(db: Db, instrumentId: string, input: unknown, actor: string): Promise<VerificationStatus> {
  const evidence = parse(VerificationEvidence, input);
  return db.$transaction(async (tx) => {
    const before = await loadInstrument(tx, instrumentId);
    const r = applyEvidence(before.state, evidence, actor);
    if (!r.ok) throw new WorkflowRejected({ code: 'INVALID_STATE', detail: r.error.detail });
    const n = await tx.instrument.updateMany({
      where: { id: instrumentId, version: before.rowVersion },
      data: {
        verificationStatus: toDb(r.state.verificationStatus),
        verifiedSoftwareVersion: r.state.verifiedSoftwareVersion ?? null,
        ...(r.state.verificationStatus === 'suspended' ? { enabled: false } : {}),
        version: { increment: 1 },
      },
    });
    if (n.count !== 1) throw new ConcurrentChange(instrumentId);
    await tx.instrumentVerificationEvidence.create({
      data: {
        id: uuidv7(),
        instrumentId,
        kind: evidence.kind,
        evidenceJson: evidence as unknown as JsonInput,
        fromStatus: toDb(before.state.verificationStatus),
        toStatus: toDb(r.state.verificationStatus),
        recordedBy: actor,
      },
    });
    await appendAudit(tx, {
      actor,
      action: `instrument.evidence.${evidence.kind}`,
      entityType: 'instrument',
      entityId: instrumentId,
      ...('reason' in evidence ? { reason: evidence.reason } : {}),
      before: { status: before.state.verificationStatus },
      after: { status: r.state.verificationStatus, evidence },
    });
    return r.state.verificationStatus;
  });
}

/**
 * Turn the analyzer link on or off. Enabling does not by itself allow
 * clinical release: that still needs LAB_ACCEPTED and the verified
 * software version (the clinical gate). A suspended instrument stays off.
 */
export async function setInstrumentEnabled(db: Db, instrumentId: string, enabled: boolean, actor: string, reason: string): Promise<void> {
  const why = reason.trim();
  if (why.length < 5) throw new WorkflowRejected({ code: 'REASON_REQUIRED', detail: 'give a reason of at least 5 characters' });
  await db.$transaction(async (tx) => {
    const i = await tx.instrument.findUnique({ where: { id: instrumentId } });
    if (!i) throw new WorkflowRejected({ code: 'INVALID_STATE', detail: `instrument ${instrumentId} is not registered` });
    if (enabled && i.verificationStatus === 'SUSPENDED') throw new WorkflowRejected({ code: 'INVALID_STATE', detail: 'a suspended instrument goes back through verification before it is enabled' });
    if (i.enabled === enabled) return;
    await tx.instrument.update({ where: { id: instrumentId }, data: { enabled, version: { increment: 1 } } });
    await appendAudit(tx, { actor, action: enabled ? 'instrument.enable' : 'instrument.disable', entityType: 'instrument', entityId: instrumentId, reason: why });
  });
}

// ---------- Test mappings ----------

const MappingList = z.array(TestMapping);

function rowToSet(row: { instrumentId: string; versionNo: number; status: string; createdBy: string; approvedBy: string | null; approvedAt: Date | null; mappingsJson: unknown }): TestMappingSet {
  return TestMappingSet.parse({
    instrumentId: row.instrumentId,
    versionNo: row.versionNo,
    status: row.status.toLowerCase() as MappingSetStatus,
    createdBy: row.createdBy,
    mappings: row.mappingsJson,
    ...(row.approvedBy ? { approvedBy: row.approvedBy } : {}),
    ...(row.approvedAt ? { approvedAt: row.approvedAt.toISOString() } : {}),
  });
}

/**
 * Save a draft mapping set (the reviewed mapping file, 13 phase 2). There is
 * at most one open draft per instrument: saving again replaces its content
 * and makes the person saving it its author, so they cannot approve it.
 */
export async function saveMappingDraft(db: Db, instrumentId: string, mappings: unknown, actor: string): Promise<number> {
  const list = parse(MappingList, mappings);
  return db.$transaction(async (tx) => {
    if (!(await tx.instrument.findUnique({ where: { id: instrumentId } }))) throw new WorkflowRejected({ code: 'INVALID_STATE', detail: `instrument ${instrumentId} is not registered` });
    const draft = await tx.testMappingSet.findFirst({ where: { instrumentId, status: 'DRAFT' } });
    const latest = await tx.testMappingSet.findFirst({ where: { instrumentId }, orderBy: { versionNo: 'desc' } });
    const versionNo = draft?.versionNo ?? (latest?.versionNo ?? 0) + 1;
    // Validate the whole set (duplicate codes and so on) before storing.
    parse(TestMappingSet, { instrumentId, versionNo, status: 'draft', createdBy: actor, mappings: list });
    if (draft) await tx.testMappingSet.update({ where: { id: draft.id }, data: { mappingsJson: list as unknown as JsonInput, createdBy: actor } });
    else await tx.testMappingSet.create({ data: { id: uuidv7(), instrumentId, versionNo, status: 'DRAFT', createdBy: actor, mappingsJson: list as unknown as JsonInput } });
    await appendAudit(tx, { actor, action: 'mapping.draft', entityType: 'test_mapping_set', entityId: `${instrumentId}:v${versionNo}`, after: list });
    return versionNo;
  });
}

/** Approve a draft (a different person from its author, rule 6), then make it the active set, retiring the previous one. */
export async function approveAndActivateMappings(db: Db, instrumentId: string, versionNo: number, approver: string): Promise<void> {
  await db.$transaction(async (tx) => {
    const row = await tx.testMappingSet.findUnique({ where: { instrumentId_versionNo: { instrumentId, versionNo } } });
    if (!row) throw new WorkflowRejected({ code: 'INVALID_STATE', detail: `mapping set v${versionNo} not found` });
    const approved = approveMappings(rowToSet(row), approver, new Date().toISOString());
    if (!approved.ok) throw new WorkflowRejected({ code: approved.error.code === 'SAME_PERSON' ? 'SAME_PERSON' : 'INVALID_STATE', detail: approved.error.detail });
    const activeRow = await tx.testMappingSet.findFirst({ where: { instrumentId, status: 'ACTIVE' } });
    const activated = activateMappings(approved.value, activeRow ? rowToSet(activeRow) : undefined);
    if (!activated.ok) throw new WorkflowRejected({ code: 'INVALID_STATE', detail: activated.error.detail });
    const now = new Date();
    if (activeRow) await tx.testMappingSet.update({ where: { id: activeRow.id }, data: { status: 'RETIRED' } });
    const n = await tx.testMappingSet.updateMany({ where: { id: row.id, status: 'DRAFT' }, data: { status: 'ACTIVE', approvedBy: approver, approvedAt: now, activeFrom: now } });
    if (n.count !== 1) throw new ConcurrentChange(row.id);
    await appendAudit(tx, {
      actor: approver,
      action: 'mapping.approve-activate',
      entityType: 'test_mapping_set',
      entityId: `${instrumentId}:v${versionNo}`,
      before: { active: activeRow?.versionNo ?? null },
      after: { active: versionNo, author: row.createdBy },
    });
  });
}

export const MAPPING_FILE_EXAMPLE: TestMapping[] = [
  { localTestCode: 'TSH', instrumentTestCode: '10', direction: 'both', expectedUnits: 'uIU/mL', reportable: true, ruo: false },
];

export interface MappingChange {
  kind: 'added' | 'removed' | 'changed';
  instrumentTestCode: string;
  instrumentCodeSystem?: string;
  localTestCode: string;
  /** For "changed": each field as "field: before → after". */
  fields: string[];
}

/**
 * What a draft changes against the active set, keyed by instrument code and
 * code system, so the approver checks the differences and not only the end
 * state (rule 6, W-9).
 */
export function diffMappings(before: TestMapping[], after: TestMapping[]): MappingChange[] {
  const key = (m: TestMapping) => `${m.instrumentTestCode}\u0000${m.instrumentCodeSystem ?? ''}`;
  const show = (v: unknown) => (v === undefined ? '(none)' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  const old = new Map(before.map((m) => [key(m), m]));
  const out: MappingChange[] = [];
  const base = (m: TestMapping) => ({ instrumentTestCode: m.instrumentTestCode, ...(m.instrumentCodeSystem ? { instrumentCodeSystem: m.instrumentCodeSystem } : {}), localTestCode: m.localTestCode });
  for (const m of after) {
    const o = old.get(key(m));
    old.delete(key(m));
    if (!o) {
      out.push({ kind: 'added', ...base(m), fields: [] });
      continue;
    }
    const fields: string[] = [];
    for (const f of ['localTestCode', 'direction', 'expectedUnits', 'decimals', 'qualitativeMap', 'reportable', 'ruo'] as const) {
      if (JSON.stringify(o[f]) !== JSON.stringify(m[f])) fields.push(`${f}: ${show(o[f])} → ${show(m[f])}`);
    }
    if (fields.length) out.push({ kind: 'changed', ...base(m), fields });
  }
  for (const o of old.values()) out.push({ kind: 'removed', ...base(o), fields: [] });
  return out;
}

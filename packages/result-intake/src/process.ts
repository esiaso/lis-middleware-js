import { InstrumentConnectionConfig, TestMappingSet, type NormalizedAnalyzerMessage, type ResultValue } from '@lis/contracts';
import { mapObservation } from '@lis/domain';
import { claimInbox, completeInbox, decimal, failInbox, uuidv7, type ClaimedInbox, type Db, type DecimalValue, type JsonInput } from '@lis/db';
import { matchNormalizedMessage, type MatchSummary } from '@lis/lab';
import { decodeRaw, PermanentDecodeError } from './decode.js';

export interface IntakeOutcome {
  inboxId: string;
  status: 'done' | 'retry' | 'dead';
  messages: number;
  observations: number;
  unmapped: number;
  /** Observations that became result versions. */
  matched?: number;
  notes: string[];
  error?: string;
}

/** Load the mapping set that is ACTIVE now, validated against the contract. */
async function activeMappingSet(db: Db, instrumentId: string): Promise<TestMappingSet | undefined> {
  const row = await db.testMappingSet.findFirst({ where: { instrumentId, status: 'ACTIVE' }, orderBy: { versionNo: 'desc' } });
  if (!row) return undefined;
  return TestMappingSet.parse({
    instrumentId: row.instrumentId,
    versionNo: row.versionNo,
    status: 'active',
    createdBy: row.createdBy,
    approvedBy: row.approvedBy ?? undefined,
    approvedAt: row.approvedAt?.toISOString(),
    mappings: row.mappingsJson,
  });
}

function numeric(v: ResultValue): DecimalValue | null {
  return v.kind === 'numeric' ? decimal(v.value) : null;
}

/**
 * Turn one analyzer inbox row into normalised results. Everything for one
 * raw message (all its samples and observations, plus marking the inbox row
 * done) commits in one transaction, so a crash or retry never leaves half a
 * message behind and never duplicates one.
 */
export async function processAnalyzerInbox(db: Db, worker: string, item: ClaimedInbox): Promise<IntakeOutcome> {
  const base = { inboxId: item.id, messages: 0, observations: 0, unmapped: 0, notes: [] as string[] };
  try {
    if (!item.rawMessageId) throw new PermanentDecodeError('analyzer inbox row without raw message');
    const raw = await db.rawMessage.findUniqueOrThrow({ where: { id: item.rawMessageId } });
    // Decode with the configuration that was active when the message arrived.
    const connRow = await db.instrumentConnection.findFirst({
      where: { instrumentId: raw.instrumentId, activeFrom: { lte: raw.receivedAt }, OR: [{ activeTo: null }, { activeTo: { gt: raw.receivedAt } }] },
      orderBy: { activeFrom: 'desc' },
    });
    if (!connRow) throw new PermanentDecodeError('no connection configuration was active when the message arrived');
    const conn = InstrumentConnectionConfig.parse(connRow.configJson);
    const decoded = decodeRaw(conn, Buffer.from(raw.bytes), { rawMessageId: raw.id, instrumentId: raw.instrumentId, receivedAt: raw.receivedAt.toISOString() });
    const mappings = await activeMappingSet(db, raw.instrumentId);

    let observations = 0;
    let unmapped = 0;
    const matches: MatchSummary[] = [];
    await db.$transaction(async (tx) => {
      for (const [i, m] of decoded.messages.entries()) {
        const nmId = uuidv7();
        await tx.normalizedMessage.create({
          data: {
            id: nmId,
            rawMessageId: raw.id,
            seq: i + 1,
            instrumentId: raw.instrumentId,
            adapterName: m.adapter.name,
            adapterVersion: m.adapter.version,
            kind: m.kind,
            sampleClass: m.sampleClass,
            sampleId: m.sampleId ?? null,
            sampleIdReadError: m.sampleIdReadError,
            mappingVersionNo: mappings?.versionNo ?? null,
            payload: m as unknown as JsonInput,
          },
        });
        for (const [j, o] of m.observations.entries()) {
          const mapped = qcOrMap(m, mappings, o);
          if (mapped.mapping === 'UNMAPPED') unmapped++;
          observations++;
          await tx.observation.create({
            data: {
              id: uuidv7(),
              normalizedMessageId: nmId,
              seq: j + 1,
              instrumentTestCode: o.instrumentTestCode,
              instrumentCodeSystem: o.instrumentCodeSystem ?? null,
              originalValueText: o.originalValueText,
              value: o.value as unknown as JsonInput,
              numericValue: numeric(o.value),
              units: o.units ?? null,
              abnormalFlags: o.abnormalFlags,
              mapping: mapped.mapping,
              localTestCode: mapped.localTestCode,
            },
          });
        }
        if (m.kind === 'result') matches.push(await matchNormalizedMessage(tx, nmId));
      }
      await completeInbox(tx, item.id, worker);
    });
    const matched = matches.reduce((n, m) => n + m.matched, 0);
    return { ...base, status: 'done', messages: decoded.messages.length, observations, unmapped, matched, notes: decoded.notes };
  } catch (e) {
    const permanent = e instanceof PermanentDecodeError;
    const error = (e as Error).message;
    await failInbox(db, item.id, worker, error, { permanent });
    return { ...base, status: permanent ? 'dead' : 'retry', error };
  }
}

function qcOrMap(
  m: NormalizedAnalyzerMessage,
  set: TestMappingSet | undefined,
  o: NormalizedAnalyzerMessage['observations'][number],
): { mapping: 'MAPPED' | 'UNMAPPED' | 'NOT_REPORTABLE' | 'QC'; localTestCode: string | null } {
  const r = mapObservation(set, o);
  const local = r.status === 'unmapped' ? null : r.mapping.localTestCode;
  // QC is kept apart from patient results whatever the mapping says (T-16).
  if (m.sampleClass === 'qc') return { mapping: 'QC', localTestCode: local };
  if (r.status === 'mapped') return { mapping: 'MAPPED', localTestCode: local };
  if (r.status === 'not-reportable') return { mapping: 'NOT_REPORTABLE', localTestCode: local };
  return { mapping: 'UNMAPPED', localTestCode: null };
}

/** Claim and process one batch of analyzer inbox rows. */
export async function runIntakeBatch(db: Db, worker: string, limit = 10): Promise<IntakeOutcome[]> {
  const items = await claimInbox(db, worker, limit, 120, 'analyzer:');
  const out: IntakeOutcome[] = [];
  for (const item of items) out.push(await processAnalyzerInbox(db, worker, item));
  return out;
}

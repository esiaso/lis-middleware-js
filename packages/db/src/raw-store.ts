import { createHash } from 'node:crypto';
import type { AstmFrameRecord, AstmTransferRecord, RawMessageStore } from '@lis/analyzer-runtime';
import type { Db } from './client.js';
import type { Lease } from './lease.js';
import { uuidv7 } from './uuid.js';

/** Prisma wants a Uint8Array backed by a plain ArrayBuffer; copying also detaches us from pooled Buffers. */
const bytes = (b: Buffer): Uint8Array<ArrayBuffer> => new Uint8Array(b);

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** Open a link session row; every frame and message of this connection points at it. */
export async function startLinkSession(db: Db, lease: Lease): Promise<string> {
  const id = uuidv7();
  await db.linkSession.create({ data: { id, instrumentId: lease.instrumentId, leaseEpoch: lease.epoch, owner: lease.owner } });
  return id;
}

export async function endLinkSession(db: Db, id: string, reason: string): Promise<void> {
  await db.linkSession.update({ where: { id }, data: { endedAt: new Date(), endReason: reason } });
}

/**
 * PostgreSQL implementation of the analyzer worker's raw store. Every write
 * carries the lease epoch; the fencing trigger rejects it if the lease was
 * lost, so the session NAKs (ASTM) or stays silent (MLLP) instead of ACKing.
 * A complete inbound message and its inbox row commit in one transaction.
 */
export class PrismaRawMessageStore implements RawMessageStore {
  #seq = 0;

  constructor(
    private readonly db: Db,
    private readonly lease: Lease,
    private readonly linkSessionId: string,
  ) {}

  async storeAstmFrame(f: AstmFrameRecord): Promise<void> {
    await this.db.rawFrame.create({
      data: {
        id: uuidv7(),
        instrumentId: this.lease.instrumentId,
        leaseEpoch: this.lease.epoch,
        linkSessionId: this.linkSessionId,
        seq: ++this.#seq,
        fn: f.fn,
        bytes: bytes(f.raw),
        final: f.final,
        receivedAt: f.receivedAt,
      },
    });
  }

  async storeAstmTransfer(t: AstmTransferRecord): Promise<string> {
    const id = uuidv7();
    await this.db.$transaction(async (tx) => {
      await tx.rawMessage.create({
        data: {
          id,
          instrumentId: this.lease.instrumentId,
          leaseEpoch: this.lease.epoch,
          linkSessionId: this.linkSessionId,
          direction: 'IN',
          protocol: 'astm-e1381',
          bytes: bytes(t.text),
          sha256: sha256(t.text),
          complete: t.complete,
          abortedReason: t.abortedReason ?? null,
          receivedAt: t.receivedAt,
          transportAck: t.abortedReason ? 'NOT_APPLICABLE' : 'ACKED',
        },
      });
      await tx.rawFrame.updateMany({ where: { linkSessionId: this.linkSessionId, rawMessageId: null }, data: { rawMessageId: id } });
      if (t.complete && !t.abortedReason) await this.#enqueue(tx, id);
    });
    return id;
  }

  async storeMllpMessage(m: { payload: Buffer; receivedAt: Date }): Promise<string> {
    const id = uuidv7();
    await this.db.$transaction(async (tx) => {
      await tx.rawMessage.create({
        data: {
          id,
          instrumentId: this.lease.instrumentId,
          leaseEpoch: this.lease.epoch,
          linkSessionId: this.linkSessionId,
          direction: 'IN',
          protocol: 'hl7-mllp',
          bytes: bytes(m.payload),
          sha256: sha256(m.payload),
          complete: true,
          receivedAt: m.receivedAt,
          // Set before the ACK is written; a failed write is visible in the link log, and the instrument resends.
          transportAck: 'ACKED',
        },
      });
      await this.#enqueue(tx, id);
    });
    return id;
  }

  async #enqueue(tx: Pick<Db, 'inboxMessage'>, rawMessageId: string): Promise<void> {
    await tx.inboxMessage.create({
      data: { id: uuidv7(), source: `analyzer:${this.lease.instrumentId}`, externalId: rawMessageId, rawMessageId },
    });
  }
}

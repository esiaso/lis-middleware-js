/** MLLP block characters [Mindray HL7 §1; HL7 v2.3.1 MLLP]. */
export const SB = 0x0b;
export const EB = 0x1c;
export const CR = 0x0d;

export type MllpUnit =
  | { type: 'message'; payload: Buffer }
  | { type: 'noise'; bytes: Buffer; reason: string }
  /** The current block exceeded the size limit. The caller should close the connection. */
  | { type: 'overflow'; discardedBytes: number };

export function mllpWrap(payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from([SB]), payload, Buffer.from([EB, CR])]);
}

/**
 * Extracts MLLP blocks from a byte stream. Handles partial blocks and several
 * blocks in one read. Memory is bounded by `maxMessageBytes`; once exceeded the
 * block is discarded up to the next start byte and an `overflow` unit is emitted.
 */
export class MllpDecoder {
  private chunks: Buffer[] = [];
  private size = 0;
  private inBlock = false;
  private sawEb = false;
  private discarding = false;
  private discarded = 0;

  constructor(private readonly maxMessageBytes = 4 * 1024 * 1024) {}

  get bufferedBytes(): number {
    return this.size;
  }

  reset(): void {
    this.chunks = [];
    this.size = 0;
    this.inBlock = false;
    this.sawEb = false;
    this.discarding = false;
    this.discarded = 0;
  }

  push(chunk: Buffer): MllpUnit[] {
    const out: MllpUnit[] = [];
    let i = 0;
    while (i < chunk.length) {
      if (!this.inBlock) {
        const start = chunk.indexOf(SB, i);
        const end = start === -1 ? chunk.length : start;
        // Whitespace (e.g. a stray CR/LF between blocks) is tolerated silently.
        const between = chunk.subarray(i, end);
        if (between.some((b) => b !== CR && b !== 0x0a)) {
          out.push({ type: 'noise', bytes: Buffer.from(between), reason: 'bytes outside MLLP block' });
        }
        if (start === -1) break;
        this.inBlock = true;
        this.sawEb = false;
        i = start + 1;
        continue;
      }

      if (this.sawEb) {
        // Expecting CR after EB.
        const b = chunk[i] as number;
        if (b === CR) {
          i++;
          this.emit(out);
        } else {
          // Tolerate a missing CR: end the block anyway and reprocess this byte.
          out.push({ type: 'noise', bytes: Buffer.alloc(0), reason: 'missing CR after end block' });
          this.emit(out);
        }
        continue;
      }

      const eb = chunk.indexOf(EB, i);
      const sb = chunk.indexOf(SB, i);
      if (sb !== -1 && (eb === -1 || sb < eb)) {
        // New start before end: previous block is incomplete.
        this.append(chunk.subarray(i, sb));
        out.push({ type: 'noise', bytes: Buffer.concat(this.chunks), reason: 'block restarted before end' });
        this.chunks = [];
        this.size = 0;
        this.discarding = false;
        i = sb + 1;
        continue;
      }
      const stop = eb === -1 ? chunk.length : eb;
      this.append(chunk.subarray(i, stop));
      if (eb === -1) break;
      this.sawEb = true;
      i = eb + 1;
    }
    return out;
  }

  private append(part: Buffer): void {
    if (part.length === 0) return;
    if (this.discarding) {
      this.discarded += part.length;
      return;
    }
    if (this.size + part.length > this.maxMessageBytes) {
      this.discarding = true;
      this.discarded = this.size + part.length;
      this.chunks = [];
      this.size = 0;
      return;
    }
    this.chunks.push(Buffer.from(part));
    this.size += part.length;
  }

  private emit(out: MllpUnit[]): void {
    if (this.discarding) out.push({ type: 'overflow', discardedBytes: this.discarded });
    else out.push({ type: 'message', payload: Buffer.concat(this.chunks, this.size) });
    this.chunks = [];
    this.size = 0;
    this.inBlock = false;
    this.sawEb = false;
    this.discarding = false;
    this.discarded = 0;
  }
}

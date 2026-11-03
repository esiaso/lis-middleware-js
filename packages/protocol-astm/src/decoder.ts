import { CONTROL_BY_BYTE, CR, ETB, ETX, LF, MAX_FRAME_BYTES, STX, type ControlChar } from './constants.js';
import { astmChecksum } from './frame.js';

export type DecodedUnit =
  | { type: 'control'; char: ControlChar }
  | {
      type: 'frame';
      /** Frame number 0-7, or -1 if the FN byte was not a digit. */
      fn: number;
      text: Buffer;
      final: boolean;
      checksumOk: boolean;
      /** The complete frame bytes as received, for raw storage. */
      raw: Buffer;
      /** Why the frame is unusable, if it is (bad checksum, malformed trailer…). */
      error?: string;
    }
  /** Bytes outside any frame that were not control characters, or an abandoned partial frame. */
  | { type: 'noise'; bytes: Buffer; reason: string };

export interface AstmDecoderOptions {
  /** Upper bound on one frame including framing; frames beyond this are dropped. Default 512 (spec max 247). */
  maxFrameBytes?: number;
}

/**
 * Turns arbitrary byte chunks into ASTM E1381 units.
 *
 * It never assumes one read equals one frame: a chunk may hold half a frame,
 * several frames, or a frame plus control characters. Memory is bounded by
 * `maxFrameBytes`. It performs no I/O.
 */
export class AstmDecoder {
  private readonly maxFrameBytes: number;
  /** Bytes of the frame currently being collected, starting at STX. */
  private frame: number[] | null = null;
  /** Bytes after ETX/ETB still expected: C1 C2 CR LF. */
  private trailerRemaining = 0;

  constructor(opts: AstmDecoderOptions = {}) {
    this.maxFrameBytes = Math.max(opts.maxFrameBytes ?? 512, MAX_FRAME_BYTES);
  }

  get bufferedBytes(): number {
    return this.frame?.length ?? 0;
  }

  reset(): void {
    this.frame = null;
    this.trailerRemaining = 0;
  }

  push(chunk: Uint8Array): DecodedUnit[] {
    const out: DecodedUnit[] = [];
    let noise: number[] = [];
    const flushNoise = (reason: string) => {
      if (noise.length) out.push({ type: 'noise', bytes: Buffer.from(noise), reason });
      noise = [];
    };

    for (const b of chunk) {
      if (this.frame === null) {
        if (b === STX) {
          flushNoise('bytes outside frame');
          this.frame = [b];
          this.trailerRemaining = 0;
          continue;
        }
        const ctl = CONTROL_BY_BYTE.get(b);
        if (ctl) {
          flushNoise('bytes outside frame');
          out.push({ type: 'control', char: ctl });
          continue;
        }
        noise.push(b);
        continue;
      }

      // Inside a frame.
      if (this.trailerRemaining > 0) {
        this.frame.push(b);
        this.trailerRemaining--;
        if (this.trailerRemaining === 0) {
          out.push(this.finishFrame(this.frame));
          this.frame = null;
        }
        continue;
      }

      if (b === STX) {
        // A new STX before the old frame ended: abandon the partial frame.
        out.push({ type: 'noise', bytes: Buffer.from(this.frame), reason: 'frame restarted before completion' });
        this.frame = [b];
        continue;
      }
      const ctl = CONTROL_BY_BYTE.get(b);
      if (ctl && b !== ETX && b !== ETB) {
        // EOT/ENQ/ACK/NAK cannot occur in frame text: the frame was abandoned.
        out.push({ type: 'noise', bytes: Buffer.from(this.frame), reason: `${ctl} inside frame` });
        this.frame = null;
        out.push({ type: 'control', char: ctl });
        continue;
      }

      this.frame.push(b);
      if (b === ETX || b === ETB) {
        this.trailerRemaining = 4; // C1 C2 CR LF
      } else if (this.frame.length >= this.maxFrameBytes) {
        out.push({ type: 'noise', bytes: Buffer.from(this.frame), reason: 'frame exceeds size limit' });
        this.frame = null;
      }
    }
    flushNoise('bytes outside frame');
    return out;
  }

  private finishFrame(bytes: number[]): DecodedUnit {
    const raw = Buffer.from(bytes);
    // raw = STX FN text... TERM C1 C2 CR LF
    const termIdx = raw.length - 5;
    const term = raw[termIdx];
    const fnByte = raw[1] ?? 0;
    const fn = fnByte >= 0x30 && fnByte <= 0x37 ? fnByte - 0x30 : -1;
    const text = raw.subarray(2, termIdx);
    const body = raw.subarray(1, termIdx + 1);
    const received = raw.subarray(termIdx + 1, termIdx + 3).toString('latin1').toUpperCase();
    const checksumOk = astmChecksum(body) === received;
    const trailerOk = raw[raw.length - 2] === CR && raw[raw.length - 1] === LF;
    const base = { type: 'frame' as const, fn, text, final: term === ETX, checksumOk: checksumOk && trailerOk, raw };
    if (raw.length < 7) return { ...base, checksumOk: false, error: 'frame too short' };
    if (fn < 0) return { ...base, checksumOk: false, error: 'invalid frame number' };
    if (!trailerOk) return { ...base, error: 'missing CR LF after checksum' };
    if (!checksumOk) return { ...base, error: `checksum mismatch (got ${received}, expected ${astmChecksum(body)})` };
    return base;
  }
}

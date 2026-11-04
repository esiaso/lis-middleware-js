import { ACK, ENQ, EOT, NAK } from './constants.js';
import type { DecodedUnit } from './decoder.js';
import { encodeMessageFrames, nextFrameNumber, type FrameSplitMode } from './frame.js';

/**
 * Timings. Defaults follow the cobas e 411 description of its own behaviour
 * [e411 HIM D-5 to D-10]; every value is configurable so it can be tuned to
 * what interface testing observes on the installed instrument.
 */
export interface AstmLinkTimings {
  /** Sender: wait for a reply to ENQ or to a frame. e 411: 15 s. */
  replyTimeoutMs: number;
  /** Sender: wait after NAK to ENQ before retrying. e 411: 10 s. */
  busyRetryDelayMs: number;
  /** Sender: max retries after NAK to ENQ, and max retransmissions of a frame. e 411: 6. */
  maxRetries: number;
  /** Receiver: give up on a transfer with no frame or EOT for this long. e 411 as receiver: 15 s. */
  receiveTimeoutMs: number;
  /** Sender: after yielding on contention, wait at least this long before sending ENQ again. */
  contentionBackoffMs: number;
}

export const E411_DEFAULT_TIMINGS: AstmLinkTimings = {
  replyTimeoutMs: 15_000,
  busyRetryDelayMs: 10_000,
  maxRetries: 6,
  receiveTimeoutMs: 15_000,
  contentionBackoffMs: 1_000,
};

export type LinkState = 'idle' | 'receiving' | 'awaiting-commit' | 'establishing' | 'busy-wait' | 'sending';

export interface OutboundMessage {
  id: string;
  /** Records, each terminated by CR. */
  body: Buffer;
}

export type LinkAction =
  | { type: 'write'; bytes: Buffer; note: string }
  /**
   * A good, new frame arrived. The driver MUST persist it and then call
   * `commitFrame(true)` (sends ACK) or `commitFrame(false)` (sends NAK).
   * Nothing is ACKed before the driver confirms durable storage.
   */
  | { type: 'frame'; fn: number; text: Buffer; final: boolean; raw: Buffer }
  /** EOT ended a transfer. `text` is all committed frame text in order. */
  | { type: 'transfer-complete'; text: Buffer; complete: boolean; frameCount: number }
  /** A transfer was abandoned (timeout, protocol violation). Committed text so far is reported. */
  | { type: 'transfer-aborted'; text: Buffer; reason: string }
  | { type: 'sent'; id: string }
  | { type: 'send-failed'; id: string; reason: string }
  | { type: 'event'; level: 'info' | 'warn'; code: string; detail?: string };

/**
 * ASTM E1381 data-link state machine, host side, without I/O.
 *
 * The driver feeds decoded units (`onUnit`), the current time (`onTick`), and
 * commit decisions (`commitFrame`). The machine returns actions: bytes to
 * write, frames to persist, transfers to process. `nextDeadline()` tells the
 * driver when to call `onTick` next.
 */
/** Same default as the HL7 side (`maxMessageBytes` in the connection settings). */
export const DEFAULT_MAX_TRANSFER_BYTES = 4 * 1024 * 1024;

export class AstmLink {
  private state: LinkState = 'idle';
  private deadline: number | null = null;

  // receiver
  private expectedFn = 1;
  private lastCommittedFn: number | null = null;
  private committed: Buffer[] = [];
  private lastWasFinal = true;
  private pendingFrame: { fn: number; text: Buffer; final: boolean } | null = null;
  private committedBytes = 0;
  /** Set once a transfer passes maxTransferBytes: every further frame is refused until it ends. */
  private overflowBytes: number | null = null;

  // sender
  private readonly queue: OutboundMessage[] = [];
  private current: { msg: OutboundMessage; frames: Buffer[]; index: number; retries: number } | null = null;
  private enqRetries = 0;
  private notBefore = 0;

  constructor(
    private readonly timings: AstmLinkTimings = E411_DEFAULT_TIMINGS,
    private readonly splitMode: FrameSplitMode = 'packed',
    /** Largest message (sum of frame text) accepted; beyond it frames are refused and the transfer is dropped. */
    private readonly maxTransferBytes: number = DEFAULT_MAX_TRANSFER_BYTES,
  ) {}

  get currentState(): LinkState {
    return this.state;
  }

  nextDeadline(): number | null {
    if (this.state === 'idle' && this.hasOutbound()) return this.notBefore;
    return this.deadline;
  }

  /** Queue an outbound message. Sending starts at the next tick when the line is idle. */
  enqueue(msg: OutboundMessage): void {
    this.queue.push(msg);
  }

  private hasOutbound(): boolean {
    return this.current !== null || this.queue.length > 0;
  }

  get queuedCount(): number {
    return this.queue.length + (this.current ? 1 : 0);
  }

  onUnit(unit: DecodedUnit, now: number): LinkAction[] {
    if (unit.type === 'noise') {
      return [{ type: 'event', level: 'warn', code: 'noise', detail: `${unit.reason} (${unit.bytes.length} bytes)` }];
    }
    switch (this.state) {
      case 'idle':
        return this.idleUnit(unit, now);
      case 'receiving':
        return this.receivingUnit(unit, now);
      case 'awaiting-commit':
        // The instrument must wait for our reply; anything else is a protocol violation, ignore it.
        return [{ type: 'event', level: 'warn', code: 'unexpected-while-committing', detail: describe(unit) }];
      case 'establishing':
        return this.establishingUnit(unit, now);
      case 'busy-wait':
        return this.idleUnit(unit, now);
      case 'sending':
        return this.sendingUnit(unit, now);
    }
  }

  /** Driver's answer to a `frame` action. `stored=false` (e.g. database down) sends NAK. */
  commitFrame(stored: boolean, now: number): LinkAction[] {
    if (this.state !== 'awaiting-commit' || !this.pendingFrame) {
      return [{ type: 'event', level: 'warn', code: 'commit-without-frame' }];
    }
    const f = this.pendingFrame;
    this.pendingFrame = null;
    this.state = 'receiving';
    this.deadline = now + this.timings.receiveTimeoutMs;
    if (!stored) {
      return [write(NAK, 'NAK: frame not stored'), { type: 'event', level: 'warn', code: 'frame-not-stored' }];
    }
    this.committed.push(f.text);
    this.committedBytes += f.text.length;
    this.lastCommittedFn = f.fn;
    this.lastWasFinal = f.final;
    this.expectedFn = nextFrameNumber(f.fn);
    return [write(ACK, `ACK frame ${f.fn}`)];
  }

  onTick(now: number): LinkAction[] {
    if (this.state === 'idle') {
      if (this.hasOutbound() && now >= this.notBefore) return this.startEstablish(now);
      return [];
    }
    if (this.deadline === null || now < this.deadline) return [];
    switch (this.state) {
      case 'receiving': {
        const text = Buffer.concat(this.committed);
        this.resetReceiver();
        this.toIdle();
        return [{ type: 'transfer-aborted', text, reason: 'receive timeout' }];
      }
      case 'awaiting-commit':
        // Driver did not commit in time; do not ACK something we may not have stored.
        return [{ type: 'event', level: 'warn', code: 'commit-overdue' }];
      case 'establishing':
        return this.failCurrent(now, 'no reply to ENQ');
      case 'busy-wait':
        return this.startEstablish(now);
      case 'sending':
        return this.failCurrent(now, 'no reply to frame');
    }
    return [];
  }

  // ---------- receiver ----------

  private idleUnit(unit: Exclude<DecodedUnit, { type: 'noise' }>, now: number): LinkAction[] {
    if (unit.type === 'control' && unit.char === 'ENQ') {
      this.resetReceiver();
      this.state = 'receiving';
      this.deadline = now + this.timings.receiveTimeoutMs;
      return [write(ACK, 'ACK establishment')];
    }
    // "Reception other than [ENQ] is ignored in idle status" [e411 HIM D-5].
    return [{ type: 'event', level: 'info', code: 'ignored-in-idle', detail: describe(unit) }];
  }

  private receivingUnit(unit: Exclude<DecodedUnit, { type: 'noise' }>, now: number): LinkAction[] {
    if (unit.type === 'control') {
      if (unit.char === 'EOT') {
        if (this.overflowBytes !== null) {
          const reason = `message larger than ${this.maxTransferBytes} bytes (${this.overflowBytes} so far); its frames are kept, it is not processed`;
          this.resetReceiver();
          this.toIdle();
          return [{ type: 'transfer-aborted', text: Buffer.alloc(0), reason }];
        }
        const text = Buffer.concat(this.committed);
        const frameCount = this.committed.length;
        const complete = this.lastWasFinal && frameCount > 0;
        this.resetReceiver();
        this.toIdle();
        return [{ type: 'transfer-complete', text, complete, frameCount }];
      }
      if (unit.char === 'ENQ') {
        // Sender restarted establishment; treat as a fresh transfer.
        const text = Buffer.concat(this.committed);
        this.resetReceiver();
        this.deadline = now + this.timings.receiveTimeoutMs;
        return [
          { type: 'transfer-aborted', text, reason: 'ENQ during transfer' },
          write(ACK, 'ACK re-establishment'),
        ];
      }
      return [{ type: 'event', level: 'warn', code: 'unexpected-control', detail: unit.char }];
    }

    this.deadline = now + this.timings.receiveTimeoutMs;
    if (!unit.checksumOk || unit.error) {
      return [write(NAK, 'NAK bad frame'), { type: 'event', level: 'warn', code: 'bad-frame', detail: unit.error ?? 'checksum' }];
    }
    if (this.lastCommittedFn !== null && unit.fn === this.lastCommittedFn) {
      // Retransmission of a frame we already stored (our ACK was lost). ACK again, do not append.
      return [write(ACK, `ACK duplicate frame ${unit.fn}`), { type: 'event', level: 'info', code: 'duplicate-frame', detail: String(unit.fn) }];
    }
    if (unit.fn !== this.expectedFn) {
      return [write(NAK, 'NAK wrong frame number'), { type: 'event', level: 'warn', code: 'frame-number', detail: `got ${unit.fn}, expected ${this.expectedFn}` }];
    }
    if (this.overflowBytes !== null) {
      this.overflowBytes += unit.text.length;
      return [write(NAK, 'NAK: message too large')];
    }
    if (this.committedBytes + unit.text.length > this.maxTransferBytes) {
      // Bounded memory: drop what was gathered (each frame is already stored) and refuse the rest.
      this.overflowBytes = this.committedBytes + unit.text.length;
      this.committed = [];
      this.committedBytes = 0;
      return [
        write(NAK, 'NAK: message too large'),
        { type: 'event', level: 'warn', code: 'transfer-too-large', detail: `over ${this.maxTransferBytes} bytes; the rest of this message is refused` },
      ];
    }
    this.pendingFrame = { fn: unit.fn, text: unit.text, final: unit.final };
    this.state = 'awaiting-commit';
    return [{ type: 'frame', fn: unit.fn, text: unit.text, final: unit.final, raw: unit.raw }];
  }

  private resetReceiver(): void {
    this.expectedFn = 1;
    this.lastCommittedFn = null;
    this.committed = [];
    this.committedBytes = 0;
    this.overflowBytes = null;
    this.lastWasFinal = true;
    this.pendingFrame = null;
  }

  // ---------- sender ----------

  private startEstablish(now: number): LinkAction[] {
    if (!this.current) {
      const msg = this.queue.shift();
      if (!msg) return [];
      this.current = { msg, frames: encodeMessageFrames(msg.body, this.splitMode), index: 0, retries: 0 };
      this.enqRetries = 0;
    }
    this.state = 'establishing';
    this.deadline = now + this.timings.replyTimeoutMs;
    return [write(ENQ, 'ENQ')];
  }

  private establishingUnit(unit: Exclude<DecodedUnit, { type: 'noise' }>, now: number): LinkAction[] {
    if (unit.type !== 'control') return [{ type: 'event', level: 'warn', code: 'frame-while-establishing' }];
    switch (unit.char) {
      case 'ACK':
        return this.sendFrame(now);
      case 'ENQ': {
        // Contention: the instrument has priority; the host stops and answers [e411 HIM D-6].
        this.state = 'receiving';
        this.resetReceiver();
        this.deadline = now + this.timings.receiveTimeoutMs;
        this.notBefore = now + this.timings.contentionBackoffMs;
        return [write(ACK, 'ACK (contention: instrument has priority)'), { type: 'event', level: 'info', code: 'contention' }];
      }
      case 'NAK': {
        this.enqRetries++;
        if (this.enqRetries > this.timings.maxRetries) return this.failCurrent(now, 'receiver busy (NAK) too many times');
        this.state = 'busy-wait';
        this.deadline = now + this.timings.busyRetryDelayMs;
        return [{ type: 'event', level: 'info', code: 'receiver-busy', detail: `retry ${this.enqRetries}` }];
      }
      case 'EOT':
        return [{ type: 'event', level: 'warn', code: 'eot-while-establishing' }];
    }
  }

  private sendingUnit(unit: Exclude<DecodedUnit, { type: 'noise' }>, now: number): LinkAction[] {
    const cur = this.current;
    if (!cur) return [];
    if (unit.type === 'control' && (unit.char === 'ACK' || unit.char === 'EOT')) {
      // EOT in reply to a frame means "accepted, please stop soon"; treat as ACK.
      cur.index++;
      cur.retries = 0;
      if (cur.index < cur.frames.length) return this.sendFrame(now);
      this.current = null;
      this.toIdle();
      return [write(EOT, 'EOT end of message'), { type: 'sent', id: cur.msg.id }];
    }
    cur.retries++;
    if (cur.retries > this.timings.maxRetries) return this.failCurrent(now, 'frame rejected too many times');
    return this.sendFrame(now, true);
  }

  private sendFrame(now: number, retransmit = false): LinkAction[] {
    const cur = this.current;
    if (!cur) return [];
    const frame = cur.frames[cur.index];
    if (!frame) return [];
    this.state = 'sending';
    this.deadline = now + this.timings.replyTimeoutMs;
    return [{ type: 'write', bytes: frame, note: `${retransmit ? 'resend' : 'send'} frame ${cur.index + 1}/${cur.frames.length}` }];
  }

  private failCurrent(now: number, reason: string): LinkAction[] {
    const cur = this.current;
    this.current = null;
    this.toIdle();
    this.notBefore = now + this.timings.busyRetryDelayMs;
    const actions: LinkAction[] = [write(EOT, `EOT after failure: ${reason}`)];
    if (cur) actions.push({ type: 'send-failed', id: cur.msg.id, reason });
    return actions;
  }

  private toIdle(): void {
    this.state = 'idle';
    this.deadline = null;
  }
}

function write(byte: number, note: string): LinkAction {
  return { type: 'write', bytes: Buffer.from([byte]), note };
}

function describe(unit: Exclude<DecodedUnit, { type: 'noise' }>): string {
  return unit.type === 'control' ? unit.char : `frame ${unit.fn}`;
}

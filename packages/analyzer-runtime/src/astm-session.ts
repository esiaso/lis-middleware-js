import { AstmDecoder, AstmLink, type AstmLinkTimings, type FrameSplitMode, type LinkAction, type OutboundMessage } from '@lis/protocol-astm';
import type { Transport } from '@lis/transport';
import { systemClock, type Clock, type LinkEvent, type RawMessageStore } from './ports.js';
import { SerialQueue } from './serial-queue.js';

export interface AstmSessionOptions {
  transport: Transport;
  store: RawMessageStore;
  timings?: AstmLinkTimings;
  splitMode?: FrameSplitMode;
  /** Largest message accepted (sum of frame text); larger transfers are refused and dropped. */
  maxMessageBytes?: number;
  clock?: Clock;
  /** Pause reading when this many units wait to be processed (backpressure). */
  highWaterUnits?: number;
  /** Called after a transfer is durably stored. May return a reply (e.g. an order query answer) to send. */
  onTransfer?: (rawMessageId: string, text: Buffer, complete: boolean) => Promise<OutboundMessage | undefined> | OutboundMessage | undefined;
  onEvent?: (e: LinkEvent) => void;
  onSent?: (id: string) => void;
  onSendFailed?: (id: string, reason: string) => void;
}

/**
 * Drives one ASTM E1381 link: transport bytes → decoder → link state machine,
 * with every frame durably stored before its ACK, and timers from the link's
 * deadlines. One session per instrument connection.
 */
export class AstmSession {
  readonly #o: Required<Pick<AstmSessionOptions, 'clock' | 'highWaterUnits'>> & AstmSessionOptions;
  readonly #decoder = new AstmDecoder();
  readonly #link: AstmLink;
  readonly #queue = new SerialQueue();
  #timer: NodeJS.Timeout | null = null;
  #paused = false;
  #stopped = false;
  readonly #onData = (chunk: Buffer) => this.#receive(chunk);
  readonly #onState = (s: string) => {
    if (s !== 'open') {
      // A dropped connection loses any half-received frame; the link times out the transfer.
      this.#decoder.reset();
    }
  };

  constructor(opts: AstmSessionOptions) {
    this.#o = { clock: systemClock, highWaterUnits: 64, ...opts };
    this.#link = new AstmLink(opts.timings, opts.splitMode, opts.maxMessageBytes);
  }

  get linkState(): string {
    return this.#link.currentState;
  }

  async start(): Promise<void> {
    this.#o.transport.on('data', this.#onData);
    this.#o.transport.on('state', this.#onState);
    await this.#o.transport.open();
    this.#schedule();
  }

  async stop(reason: string): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#o.transport.off('data', this.#onData);
    this.#o.transport.off('state', this.#onState);
    await this.#queue.idle();
    await this.#o.transport.close(reason);
  }

  /** Queue an outbound message (e.g. an order download). */
  send(msg: OutboundMessage): void {
    this.#link.enqueue(msg);
    void this.#queue.push(() => this.#tick());
  }

  /** Resolves when all received data has been processed (for tests and shutdown). */
  idle(): Promise<void> {
    return this.#queue.idle();
  }

  #receive(chunk: Buffer): void {
    for (const unit of this.#decoder.push(chunk)) {
      void this.#queue.push(async () => this.#run(this.#link.onUnit(unit, this.#o.clock.now())));
    }
    if (!this.#paused && this.#queue.pending >= this.#o.highWaterUnits) {
      this.#paused = true;
      this.#o.transport.pause();
      void this.#queue.idle().then(() => {
        this.#paused = false;
        if (!this.#stopped) this.#o.transport.resume();
      });
    }
  }

  async #tick(): Promise<void> {
    await this.#run(this.#link.onTick(this.#o.clock.now()));
  }

  async #run(actions: LinkAction[]): Promise<void> {
    for (const a of actions) {
      switch (a.type) {
        case 'write':
          try {
            await this.#o.transport.write(a.bytes);
          } catch (e) {
            this.#event('warn', 'write-failed', `${a.note}: ${(e as Error).message}`);
          }
          break;
        case 'frame': {
          let stored = false;
          try {
            await this.#o.store.storeAstmFrame({ fn: a.fn, raw: a.raw, final: a.final, receivedAt: new Date(this.#o.clock.now()) });
            stored = true;
          } catch (e) {
            this.#event('warn', 'store-failed', (e as Error).message);
          }
          await this.#run(this.#link.commitFrame(stored, this.#o.clock.now()));
          break;
        }
        case 'transfer-complete':
        case 'transfer-aborted': {
          const aborted = a.type === 'transfer-aborted';
          const complete = !aborted && a.complete;
          try {
            const id = await this.#o.store.storeAstmTransfer({
              text: a.text,
              complete,
              frameCount: aborted ? 0 : a.frameCount,
              ...(aborted ? { abortedReason: a.reason } : {}),
              receivedAt: new Date(this.#o.clock.now()),
            });
            // Partial transfers are stored for audit but never parsed into results.
            if (!aborted && this.#o.onTransfer) {
              const reply = await this.#o.onTransfer(id, a.text, complete);
              if (reply) this.#link.enqueue(reply);
            }
          } catch (e) {
            // Frames are already stored individually, so the data is not lost; reassembly can be redone.
            this.#event('warn', 'transfer-store-failed', (e as Error).message);
          }
          break;
        }
        case 'sent':
          this.#o.onSent?.(a.id);
          break;
        case 'send-failed':
          this.#o.onSendFailed?.(a.id, a.reason);
          break;
        case 'event':
          this.#event(a.level, a.code, a.detail);
          break;
      }
    }
    this.#schedule();
  }

  #event(level: 'info' | 'warn', code: string, detail?: string): void {
    this.#o.onEvent?.(detail === undefined ? { level, code } : { level, code, detail });
  }

  #schedule(): void {
    if (this.#stopped) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    const deadline = this.#link.nextDeadline();
    if (deadline === null) return;
    const delay = Math.max(0, deadline - this.#o.clock.now());
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#queue.push(() => this.#tick());
    }, delay);
  }
}

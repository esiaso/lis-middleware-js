import { MllpDecoder, mllpWrap } from '@lis/protocol-hl7v2';
import type { Transport } from '@lis/transport';
import { systemClock, type Clock, type LinkEvent, type RawMessageStore } from './ports.js';
import { SerialQueue } from './serial-queue.js';

export interface MllpSessionOptions {
  transport: Transport;
  store: RawMessageStore;
  maxMessageBytes?: number;
  clock?: Clock;
  highWaterMessages?: number;
  /**
   * Called after the payload is durably stored. Returns the reply payload
   * (an ACK, or a query answer) to send, unwrapped; the session adds MLLP framing.
   * Returning undefined sends nothing, so the instrument retries per its own rules.
   */
  onMessage: (rawMessageId: string, payload: Buffer) => Promise<Buffer | undefined> | Buffer | undefined;
  onEvent?: (e: LinkEvent) => void;
}

/**
 * Drives one HL7 v2 / MLLP link: store each block durably, then reply.
 * Nothing is acknowledged that is not stored. Oversized blocks close the
 * connection (the transport reconnects or waits for the peer).
 */
export class MllpSession {
  readonly #o: MllpSessionOptions & { clock: Clock; highWaterMessages: number };
  readonly #decoder: MllpDecoder;
  readonly #queue = new SerialQueue();
  #paused = false;
  #stopped = false;
  readonly #onData = (chunk: Buffer) => this.#receive(chunk);
  readonly #onState = (s: string) => {
    if (s !== 'open') this.#decoder.reset();
  };

  constructor(opts: MllpSessionOptions) {
    this.#o = { clock: systemClock, highWaterMessages: 16, ...opts };
    this.#decoder = new MllpDecoder(opts.maxMessageBytes);
  }

  async start(): Promise<void> {
    this.#o.transport.on('data', this.#onData);
    this.#o.transport.on('state', this.#onState);
    await this.#o.transport.open();
  }

  async stop(reason: string): Promise<void> {
    this.#stopped = true;
    this.#o.transport.off('data', this.#onData);
    this.#o.transport.off('state', this.#onState);
    await this.#queue.idle();
    await this.#o.transport.close(reason);
  }

  idle(): Promise<void> {
    return this.#queue.idle();
  }

  #receive(chunk: Buffer): void {
    for (const unit of this.#decoder.push(chunk)) {
      if (unit.type === 'noise') {
        this.#event('warn', 'noise', `${unit.reason} (${unit.bytes.length} bytes)`);
        continue;
      }
      if (unit.type === 'overflow') {
        this.#event('warn', 'overflow', `${unit.discardedBytes} bytes discarded`);
        continue;
      }
      const payload = unit.payload;
      void this.#queue.push(() => this.#handle(payload));
    }
    if (!this.#paused && this.#queue.pending >= this.#o.highWaterMessages) {
      this.#paused = true;
      this.#o.transport.pause();
      void this.#queue.idle().then(() => {
        this.#paused = false;
        if (!this.#stopped) this.#o.transport.resume();
      });
    }
  }

  async #handle(payload: Buffer): Promise<void> {
    let id: string;
    try {
      id = await this.#o.store.storeMllpMessage({ payload, receivedAt: new Date(this.#o.clock.now()) });
    } catch (e) {
      // Not stored → no ACK. The instrument resends after its own timeout.
      this.#event('warn', 'store-failed', (e as Error).message);
      return;
    }
    let reply: Buffer | undefined;
    try {
      reply = await this.#o.onMessage(id, payload);
    } catch (e) {
      this.#event('warn', 'handler-failed', (e as Error).message);
      return;
    }
    if (!reply) return;
    try {
      await this.#o.transport.write(mllpWrap(reply));
    } catch (e) {
      this.#event('warn', 'write-failed', (e as Error).message);
    }
  }

  #event(level: 'info' | 'warn', code: string, detail?: string): void {
    this.#o.onEvent?.(detail === undefined ? { level, code } : { level, code, detail });
  }
}

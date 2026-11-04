import { EventEmitter } from 'node:events';
import type { Duplex } from 'node:stream';
import { backoffDelay } from './backoff.js';

export type TransportKind = 'serial' | 'tcp-client' | 'tcp-server';
export type TransportState = 'closed' | 'connecting' | 'open' | 'backoff' | 'listening';

export class TransportNotOpenError extends Error {
  constructor() {
    super('transport is not open');
    this.name = 'TransportNotOpenError';
  }
}

export interface TransportEvents {
  data: [chunk: Buffer];
  state: [state: TransportState, detail?: string];
  /** Operational problems (connect refused, port missing). Never thrown from the supervisor loop. */
  error: [err: Error];
  /** tcp-server only: a connection refused because the peer is not allowed or one is already connected. */
  'peer-rejected': [address: string, reason: 'not-allowed' | 'already-connected'];
}

/**
 * Byte-level transport. Knows nothing about protocols (07 §1.1).
 * - `open` starts supervision: connect, and reconnect with backoff until `close`.
 * - `write` resolves once the bytes are flushed to the OS; rejects if not open or on error.
 * - `pause`/`resume` apply backpressure to the reading side.
 */
export interface Transport {
  readonly kind: TransportKind;
  readonly state: TransportState;
  open(signal?: AbortSignal): Promise<void>;
  close(reason: string): Promise<void>;
  write(bytes: Buffer): Promise<void>;
  pause(): void;
  resume(): void;
  on<E extends keyof TransportEvents>(event: E, fn: (...args: TransportEvents[E]) => void): this;
  off<E extends keyof TransportEvents>(event: E, fn: (...args: TransportEvents[E]) => void): this;
}

export interface ReconnectPolicy {
  reconnectMinMs: number;
  reconnectMaxMs: number;
  random?: () => number;
}

/**
 * Shared supervisor for transports that dial out (tcp-client, serial):
 * one live stream at a time, reconnect with jittered backoff, clean shutdown.
 */
export abstract class SupervisedStreamTransport extends EventEmitter<TransportEvents> implements Transport {
  abstract readonly kind: TransportKind;
  #state: TransportState = 'closed';
  #stream: Duplex | null = null;
  #running = false;
  #paused = false;
  #attempt = 0;
  #timer: NodeJS.Timeout | null = null;
  /** True while connectOnce() is in flight; close() then lets that attempt settle before it resolves. */
  #connecting = false;
  #closed: Promise<void> = Promise.resolve();
  #resolveClosed: (() => void) | null = null;

  constructor(private readonly policy: ReconnectPolicy) {
    super();
  }

  get state(): TransportState {
    return this.#state;
  }

  /** Create and open one stream. Rejects if it cannot be opened. */
  protected abstract connectOnce(): Promise<Duplex>;

  async open(signal?: AbortSignal): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    this.#closed = new Promise((r) => (this.#resolveClosed = r));
    signal?.addEventListener('abort', () => void this.close('aborted'), { once: true });
    void this.#connect();
  }

  async close(reason: string): Promise<void> {
    if (!this.#running) return this.#closed;
    this.#running = false;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    const s = this.#stream;
    if (s && !s.destroyed) s.destroy();
    else if (!this.#connecting) this.#finishClose(reason);
    // else: the attempt in flight sees #running is false and finishes the close itself, without reporting its error.
    return this.#closed;
  }

  write(bytes: Buffer): Promise<void> {
    const s = this.#stream;
    if (this.#state !== 'open' || !s || s.destroyed) return Promise.reject(new TransportNotOpenError());
    return new Promise((resolve, reject) => {
      s.write(bytes, (err) => (err ? reject(err) : resolve()));
    });
  }

  pause(): void {
    this.#paused = true;
    this.#stream?.pause();
  }

  resume(): void {
    this.#paused = false;
    this.#stream?.resume();
  }

  #setState(s: TransportState, detail?: string): void {
    if (this.#state === s) return;
    this.#state = s;
    this.emit('state', s, detail);
  }

  async #connect(): Promise<void> {
    if (!this.#running) return;
    this.#setState('connecting');
    let stream: Duplex;
    this.#connecting = true;
    try {
      stream = await this.connectOnce();
    } catch (e) {
      this.#connecting = false;
      if (!this.#running) {
        this.#finishClose('closed while connecting');
        return;
      }
      this.#emitError(e);
      this.#scheduleReconnect();
      return;
    }
    this.#connecting = false;
    if (!this.#running) {
      stream.destroy();
      this.#finishClose('closed while connecting');
      return;
    }
    this.#attempt = 0;
    this.#stream = stream;
    stream.on('data', (chunk: Buffer) => this.emit('data', chunk));
    stream.on('error', (e) => this.#emitError(e));
    stream.once('close', () => {
      this.#stream = null;
      if (this.#running) this.#scheduleReconnect();
      else this.#finishClose('closed');
    });
    if (this.#paused) stream.pause();
    this.#setState('open');
  }

  #scheduleReconnect(): void {
    if (!this.#running) {
      this.#finishClose('closed');
      return;
    }
    const delay = backoffDelay(this.#attempt++, this.policy.reconnectMinMs, this.policy.reconnectMaxMs, this.policy.random);
    this.#setState('backoff', `retry in ${delay} ms`);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#connect();
    }, delay);
  }

  #finishClose(reason: string): void {
    this.#setState('closed', reason);
    this.#resolveClosed?.();
    this.#resolveClosed = null;
  }

  #emitError(e: unknown): void {
    // Only emit when someone listens: an unhandled 'error' event would crash the worker.
    if (this.listenerCount('error') > 0) this.emit('error', e instanceof Error ? e : new Error(String(e)));
  }
}

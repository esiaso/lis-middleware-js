import { EventEmitter } from 'node:events';
import net from 'node:net';
import { TransportNotOpenError, type Transport, type TransportEvents, type TransportState } from './transport.js';

export interface TcpServerOptions {
  bindAddress: string;
  port: number;
  /** Only these peers may connect: instrument links are cleartext (10 §5). */
  allowedPeers: string[];
}

/** "::ffff:10.0.0.5" → "10.0.0.5" so IPv4 allow-list entries match dual-stack sockets. */
export function normalisePeer(address: string | undefined): string {
  if (!address) return '';
  return address.startsWith('::ffff:') && net.isIPv4(address.slice(7)) ? address.slice(7) : address;
}

/**
 * Listens for an instrument that connects to us (common for HL7/MLLP analyzers).
 * Exactly one peer at a time: a second connection is refused, so two senders
 * can never interleave bytes in one decoder.
 */
export class TcpServerTransport extends EventEmitter<TransportEvents> implements Transport {
  readonly kind = 'tcp-server' as const;
  #state: TransportState = 'closed';
  #server: net.Server | null = null;
  #peer: net.Socket | null = null;
  #paused = false;
  readonly #allowed: Set<string>;

  constructor(private readonly opts: TcpServerOptions) {
    super();
    this.#allowed = new Set(opts.allowedPeers.map(normalisePeer));
  }

  get state(): TransportState {
    return this.#state;
  }

  /** Port actually bound (useful when configured with port 0 in tests). */
  get boundPort(): number | undefined {
    const a = this.#server?.address();
    return typeof a === 'object' && a ? a.port : undefined;
  }

  async open(signal?: AbortSignal): Promise<void> {
    if (this.#server) return;
    const server = net.createServer((socket) => this.#onConnection(socket));
    this.#server = server;
    server.on('error', (e) => this.#emitError(e));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.opts.port, this.opts.bindAddress, () => {
        server.off('error', reject);
        resolve();
      });
    });
    signal?.addEventListener('abort', () => void this.close('aborted'), { once: true });
    this.#setState('listening');
  }

  async close(reason: string): Promise<void> {
    const server = this.#server;
    if (!server) return;
    this.#server = null;
    this.#peer?.destroy();
    await new Promise<void>((r) => server.close(() => r()));
    this.#setState('closed', reason);
  }

  write(bytes: Buffer): Promise<void> {
    const s = this.#peer;
    if (!s || s.destroyed) return Promise.reject(new TransportNotOpenError());
    return new Promise((resolve, reject) => s.write(bytes, (err) => (err ? reject(err) : resolve())));
  }

  pause(): void {
    this.#paused = true;
    this.#peer?.pause();
  }

  resume(): void {
    this.#paused = false;
    this.#peer?.resume();
  }

  #onConnection(socket: net.Socket): void {
    socket.on('error', (e) => this.#emitError(e));
    const peer = normalisePeer(socket.remoteAddress);
    if (!this.#allowed.has(peer)) {
      socket.destroy();
      this.emit('peer-rejected', peer, 'not-allowed');
      return;
    }
    if (this.#peer && !this.#peer.destroyed) {
      socket.destroy();
      this.emit('peer-rejected', peer, 'already-connected');
      return;
    }
    this.#peer = socket;
    socket.setNoDelay(true);
    socket.on('data', (chunk: Buffer) => this.emit('data', chunk));
    socket.once('close', () => {
      if (this.#peer === socket) this.#peer = null;
      if (this.#server) this.#setState('listening', 'peer disconnected');
    });
    if (this.#paused) socket.pause();
    this.#setState('open', peer);
  }

  #setState(s: TransportState, detail?: string): void {
    if (this.#state === s) return;
    this.#state = s;
    this.emit('state', s, detail);
  }

  #emitError(e: unknown): void {
    if (this.listenerCount('error') > 0) this.emit('error', e instanceof Error ? e : new Error(String(e)));
  }
}

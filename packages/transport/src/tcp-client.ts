import net from 'node:net';
import type { Duplex } from 'node:stream';
import { SupervisedStreamTransport } from './transport.js';

export interface TcpClientOptions {
  host: string;
  port: number;
  connectTimeoutMs: number;
  keepAliveMs: number;
  reconnectMinMs: number;
  reconnectMaxMs: number;
  random?: () => number;
}

/** Dials a device server or an instrument listening on TCP. */
export class TcpClientTransport extends SupervisedStreamTransport {
  readonly kind = 'tcp-client' as const;

  constructor(private readonly opts: TcpClientOptions) {
    super(opts);
  }

  protected connectOnce(): Promise<Duplex> {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: this.opts.host, port: this.opts.port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`connect timeout after ${this.opts.connectTimeoutMs} ms to ${this.opts.host}:${this.opts.port}`));
      }, this.opts.connectTimeoutMs);
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.setNoDelay(true); // control characters (ACK, NAK) must not wait for Nagle
        socket.setKeepAlive(true, this.opts.keepAliveMs);
        resolve(socket);
      });
      // Stays attached after connect: an error before the supervisor attaches its own handler destroys the socket, which triggers a reconnect.
      socket.once('error', (e) => {
        clearTimeout(timer);
        socket.destroy();
        reject(e);
      });
    });
  }
}

import type { Duplex } from 'node:stream';
import { SerialPortStream } from '@serialport/stream';
import { SupervisedStreamTransport } from './transport.js';

/** The binding type, taken from the stream so we need no import from a package without usable typings. */
export type SerialBinding = ConstructorParameters<typeof SerialPortStream>[0]['binding'];

export interface SerialOptions {
  path: string;
  baudRate: number;
  dataBits: 7 | 8;
  parity: 'none' | 'even' | 'odd';
  stopBits: 1 | 2;
  flowControl: 'none' | 'rtscts' | 'xonxoff';
  reconnectMinMs: number;
  reconnectMaxMs: number;
  /** Defaults to the native binding; tests pass @serialport/binding-mock. */
  binding?: SerialBinding;
  random?: () => number;
}

async function nativeBinding(): Promise<SerialBinding> {
  const { autoDetect } = await import('@serialport/bindings-cpp');
  return autoDetect() as unknown as SerialBinding;
}

/** A local COM port or /dev/tty*. Reopens with backoff if the port disappears (USB adapter unplugged). */
export class SerialTransport extends SupervisedStreamTransport {
  readonly kind = 'serial' as const;

  constructor(private readonly opts: SerialOptions) {
    super(opts);
  }

  protected async connectOnce(): Promise<Duplex> {
    const binding = this.opts.binding ?? (await nativeBinding());
    const port = new SerialPortStream({
      binding,
      path: this.opts.path,
      baudRate: this.opts.baudRate,
      dataBits: this.opts.dataBits,
      parity: this.opts.parity,
      stopBits: this.opts.stopBits,
      rtscts: this.opts.flowControl === 'rtscts',
      xon: this.opts.flowControl === 'xonxoff',
      xoff: this.opts.flowControl === 'xonxoff',
      autoOpen: false,
      endOnClose: true,
    });
    await new Promise<void>((resolve, reject) => port.open((err) => (err ? reject(err) : resolve())));
    // Keeps an early error from crashing the worker before the supervisor attaches its handler.
    port.on('error', () => {});
    return port;
  }
}

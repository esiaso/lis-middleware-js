import type { TransportConfig } from '@lis/contracts';
import { SerialTransport, type SerialBinding } from './serial.js';
import { TcpClientTransport } from './tcp-client.js';
import { TcpServerTransport } from './tcp-server.js';
import type { Transport } from './transport.js';

/** Serial ports reopen after 1 s to 30 s; not in the config schema yet because no instrument needs another value. */
const SERIAL_RECONNECT = { reconnectMinMs: 1000, reconnectMaxMs: 30000 };

export function createTransport(config: TransportConfig, deps: { serialBinding?: SerialBinding } = {}): Transport {
  switch (config.type) {
    case 'tcp-client':
      return new TcpClientTransport(config);
    case 'tcp-server':
      return new TcpServerTransport(config);
    case 'serial':
      return new SerialTransport({ ...config, ...SERIAL_RECONNECT, ...(deps.serialBinding ? { binding: deps.serialBinding } : {}) });
  }
}

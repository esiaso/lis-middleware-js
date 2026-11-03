import { z } from 'zod';
import { InstrumentId } from './ids.js';

export const SerialTransportConfig = z
  .object({
    type: z.literal('serial'),
    path: z.string().min(1),
    baudRate: z.number().int().positive(),
    dataBits: z.union([z.literal(7), z.literal(8)]),
    parity: z.enum(['none', 'even', 'odd']),
    stopBits: z.union([z.literal(1), z.literal(2)]),
    /** c 111 defaults to XON/XOFF; the e 411 manual describes none. Set per site settings. */
    flowControl: z.enum(['none', 'rtscts', 'xonxoff']).default('none'),
  })
  .strict();

export const TcpClientTransportConfig = z
  .object({
    type: z.literal('tcp-client'),
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    connectTimeoutMs: z.number().int().positive().default(5000),
    keepAliveMs: z.number().int().positive().default(30000),
    reconnectMinMs: z.number().int().positive().default(1000),
    reconnectMaxMs: z.number().int().positive().default(60000),
  })
  .strict();

export const TcpServerTransportConfig = z
  .object({
    type: z.literal('tcp-server'),
    bindAddress: z.string().default('0.0.0.0'),
    port: z.number().int().min(1).max(65535),
    /** Only these peers may connect. Required: instrument links are cleartext. */
    allowedPeers: z.array(z.string().ip()).min(1),
  })
  .strict();

export const TransportConfig = z.discriminatedUnion('type', [
  SerialTransportConfig,
  TcpClientTransportConfig,
  TcpServerTransportConfig,
]);
export type TransportConfig = z.infer<typeof TransportConfig>;

export const InstrumentConnectionConfig = z
  .object({
    instrumentId: InstrumentId,
    adapter: z.enum(['cobas-e411-astm', 'cobas-c111-astm', 'mindray-hl7-mllp']),
    /** Validated again by the adapter's own schema. */
    adapterOptions: z.record(z.string(), z.unknown()).default({}),
    transport: TransportConfig,
    maxMessageBytes: z
      .number()
      .int()
      .positive()
      .max(16 * 1024 * 1024)
      .default(4 * 1024 * 1024),
  })
  .strict();
export type InstrumentConnectionConfig = z.infer<typeof InstrumentConnectionConfig>;

/**
 * Parse config and report every invalid path, without echoing values
 * (values may be secrets).
 */
export function describeConfigErrors(error: z.ZodError): string[] {
  return error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
}

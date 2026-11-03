import { describe, expect, it } from 'vitest';
import { Barcode, InstrumentConnectionConfig, describeConfigErrors } from '@lis/contracts';

describe('InstrumentConnectionConfig', () => {
  it('accepts a device-server link and applies defaults', () => {
    const c = InstrumentConnectionConfig.parse({ instrumentId: 'e411-01', adapter: 'cobas-e411-astm', transport: { type: 'tcp-client', host: '10.20.5.11', port: 4001 } });
    expect(c.transport).toMatchObject({ connectTimeoutMs: 5000, reconnectMaxMs: 60000 });
    expect(c.maxMessageBytes).toBe(4 * 1024 * 1024);
  });

  it('requires a peer allow-list for TCP listeners and reports paths without values', () => {
    const r = InstrumentConnectionConfig.safeParse({ instrumentId: 'X', adapter: 'other', transport: { type: 'tcp-server', port: 5100, allowedPeers: [] }, secret: 'hunter2' });
    expect(r.success).toBe(false);
    if (r.success) return;
    const errs = describeConfigErrors(r.error).join('\n');
    expect(errs).toMatch(/instrumentId/);
    expect(errs).toMatch(/adapter/);
    expect(errs).toMatch(/transport\.allowedPeers/);
    expect(errs).not.toMatch(/hunter2/);
  });
});

describe('Barcode', () => {
  it('limits to 22 printable ASCII characters (e 411 Sample ID max)', () => {
    expect(Barcode.safeParse('L26110300042').success).toBe(true);
    expect(Barcode.safeParse('A'.repeat(23)).success).toBe(false);
    expect(Barcode.safeParse('has space').success).toBe(false);
  });
});

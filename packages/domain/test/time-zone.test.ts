import { describe, expect, it } from 'vitest';
import { formatZoned, fromZonedLocal, isTimeZone, zonedDay, zonedLocal, zoneOffset } from '../src/index.js';

describe('lab time zone', () => {
  const t = new Date('2026-11-04T21:30:00Z');
  it('accepts IANA names only', () => {
    expect(isTimeZone('UTC')).toBe(true);
    expect(isTimeZone('Africa/Nairobi')).toBe(true);
    expect(isTimeZone('Mars/Olympus')).toBe(false);
    expect(isTimeZone('')).toBe(false);
  });

  it('shows the wall clock and says which one', () => {
    expect(formatZoned(t, 'UTC')).toBe('2026-11-04 21:30 UTC');
    expect(formatZoned(t, 'Africa/Nairobi')).toBe('2026-11-05 00:30 GMT+3');
    expect(formatZoned(t, 'Asia/Kolkata')).toBe('2026-11-05 03:00 GMT+5:30');
    expect(formatZoned(t, 'America/New_York')).toBe('2026-11-04 16:30 GMT-5');
    expect(zonedDay(t, 'Africa/Nairobi')).toBe('2026-11-05');
    expect(zonedLocal(t, 'UTC')).toBe('2026-11-04T21:30');
    expect(zoneOffset(t, 'Africa/Nairobi')).toBe(3 * 3_600_000);
  });

  it('reads a typed time in the zone', () => {
    expect(fromZonedLocal('2026-11-05T00:30', 'Africa/Nairobi')?.toISOString()).toBe('2026-11-04T21:30:00.000Z');
    expect(fromZonedLocal('2026-11-05', 'Africa/Nairobi')?.toISOString()).toBe('2026-11-04T21:00:00.000Z');
    expect(fromZonedLocal('2026-11-05', 'UTC')?.toISOString()).toBe('2026-11-05T00:00:00.000Z');
    expect(fromZonedLocal('2026-02-30', 'UTC')).toBeNull();
    expect(fromZonedLocal('yesterday', 'UTC')).toBeNull();
    // Daylight saving in New York: 02:30 on 8 March 2026 does not exist; 01:30 on 1 November 2026 happens twice.
    expect(fromZonedLocal('2026-03-08T02:30', 'America/New_York')?.toISOString()).toBe('2026-03-08T07:30:00.000Z');
    expect(fromZonedLocal('2026-11-01T01:30', 'America/New_York')?.toISOString()).toBe('2026-11-01T05:30:00.000Z');
    for (const tz of ['UTC', 'Africa/Nairobi', 'America/New_York', 'Asia/Kolkata']) expect(fromZonedLocal(zonedLocal(t, tz), tz)?.getTime()).toBe(t.getTime());
  });
});

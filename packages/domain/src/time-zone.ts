/**
 * The lab's time zone (A-24). Every time is stored as an instant (UTC); this
 * only changes how times are shown, how report days are cut, and how a time
 * a person types is read. IANA names only (for example Africa/Nairobi), from
 * the time zone data built into Node; the default is UTC.
 */
export function isTimeZone(tz: string): boolean {
  if (!tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function parts(d: Date, tz: string): Record<'year' | 'month' | 'day' | 'hour' | 'minute' | 'second', number> {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    formatters.set(tz, f);
  }
  const out: Record<string, number> = {};
  for (const p of f.formatToParts(d)) if (p.type !== 'literal') out[p.type] = Number(p.value);
  return out as Record<'year' | 'month' | 'day' | 'hour' | 'minute' | 'second', number>;
}

/** The zone's offset from UTC at that instant, in milliseconds (east positive). */
export function zoneOffset(d: Date, tz: string): number {
  const p = parts(d, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(d.getTime() / 1000) * 1000;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** "YYYY-MM-DDTHH:mm" as the wall clock in the zone shows it (for datetime-local inputs). */
export function zonedLocal(d: Date, tz: string): string {
  const p = parts(d, tz);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/** "YYYY-MM-DD": the calendar day in the zone. */
export const zonedDay = (d: Date, tz: string) => zonedLocal(d, tz).slice(0, 10);

/**
 * The instant a wall-clock time in the zone stands for. "YYYY-MM-DD" means
 * the start of that day. In a daylight-saving gap the clock time does not
 * exist and it moves forward by the gap (02:30 becomes 03:30); in an overlap
 * the earlier instant wins.
 */
export function fromZonedLocal(s: string, tz: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(s);
  if (!m) return null;
  const [y, mo, d, h, mi] = [m[1], m[2], m[3], m[4] ?? '0', m[5] ?? '0'].map(Number) as [number, number, number, number, number];
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  const check = new Date(wall);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d || h > 23 || mi > 59) return null;
  const first = wall - zoneOffset(new Date(wall), tz);
  const second = wall - zoneOffset(new Date(first), tz);
  const exact = [first, second].filter((x) => zonedLocal(new Date(x), tz) === `${m[1]}-${m[2]}-${m[3]}T${pad(h)}:${pad(mi)}`);
  return new Date(exact.length ? Math.min(...exact) : Math.max(first, second));
}

/** "YYYY-MM-DD HH:mm UTC" or, elsewhere, "YYYY-MM-DD HH:mm GMT+3": always says which clock. */
export function formatZoned(d: Date, tz: string): string {
  const local = zonedLocal(d, tz).replace('T', ' ');
  if (tz === 'UTC') return `${local} UTC`;
  const off = zoneOffset(d, tz) / 60_000;
  const sign = off < 0 ? '-' : '+';
  const a = Math.abs(off);
  return `${local} GMT${sign}${Math.floor(a / 60)}${a % 60 ? `:${pad(a % 60)}` : ''}`;
}

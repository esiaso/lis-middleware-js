/**
 * Turnaround targets (A-22): set by the lab per test and priority, measured
 * from receipt in the lab to release, the part the lab controls. The
 * middleware ships with none. The most specific target applies: test and
 * priority, then test, then priority, then one for everything.
 */
export interface TatTarget {
  id: string;
  /** Null applies to every test. */
  localTestCode: string | null;
  /** routine, urgent or stat; null applies to every priority. */
  priority: string | null;
  minutes: number;
}

export function targetFor(targets: TatTarget[], test: string, priority: string): TatTarget | null {
  let best: TatTarget | null = null;
  let score = -1;
  for (const t of targets) {
    if (t.localTestCode !== null && t.localTestCode !== test) continue;
    if (t.priority !== null && t.priority !== priority) continue;
    const s = (t.localTestCode !== null ? 2 : 0) + (t.priority !== null ? 1 : 0);
    if (s > score) {
      best = t;
      score = s;
    }
  }
  return best;
}

export const TAT_PRIORITIES = ['routine', 'urgent', 'stat'] as const;

export interface TatTargetInput {
  localTestCode: string;
  priority: string;
  minutes: string;
  reference: string;
}

export function parseTatTarget(i: TatTargetInput): { ok: true; value: { localTestCode: string | null; priority: string | null; minutes: number; reference: string } } | { ok: false; issues: string[] } {
  const issues: string[] = [];
  const m = i.minutes.trim();
  const priority = i.priority.trim();
  if (priority && !(TAT_PRIORITIES as readonly string[]).includes(priority)) issues.push('Choose routine, urgent, stat, or every priority.');
  if (!/^\d{1,5}$/.test(m) || Number(m) < 1 || Number(m) > 43_200) issues.push('Target: 1 to 43200 minutes (30 days).');
  if (i.reference.trim().length < 5 || i.reference.trim().length > 200) issues.push('Source: 5 to 200 characters naming the lab policy and its version.');
  if (issues.length) return { ok: false, issues };
  return { ok: true, value: { localTestCode: i.localTestCode.trim() || null, priority: priority || null, minutes: Number(m), reference: i.reference.trim() } };
}

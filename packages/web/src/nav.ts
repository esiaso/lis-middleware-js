/**
 * The left-hand menu (09 §1): links grouped by the lab's work, shown by role.
 * Built here rather than in the template so the current page is marked once.
 */
export interface NavLink {
  href: string;
  label: string;
  /** A Bootstrap Icons name. */
  icon: string;
  active: boolean;
  /** Work waiting behind the link, when there is any. */
  count?: number;
  /** Bootstrap badge colour for the count: danger for calls and failures, secondary otherwise. */
  countTone?: string;
}
export interface NavGroup {
  /** Stable key, used to remember a group the user folded. */
  key: string;
  label: string;
  links: NavLink[];
  /** The group holds the current page, so it is never shown folded. */
  current: boolean;
}

type Item = [href: string, label: string, icon: string, show?: (roles: readonly string[]) => boolean];

const GROUPS: [key: string, label: string, Item[]][] = [
  ['overview', 'Overview', [['/', 'Dashboard', 'speedometer2']]],
  ['specimens', 'Specimens', [['/orders', 'Orders', 'card-checklist'], ['/patients', 'Patients', 'people'], ['/worksheet', 'Worksheet', 'pencil-square'], ['/downtime', 'Downtime', 'cloud-slash']]],
  ['results', 'Results', [['/results', 'Results', 'clipboard2-pulse'], ['/critical', 'Critical', 'exclamation-triangle'], ['/unmatched', 'Unmatched', 'question-diamond'], ['/failed', 'Failed deliveries', 'x-octagon']]],
  ['quality', 'Quality', [['/qc', 'QC', 'graph-up'], ['/worksheet/qc', 'Manual QC', 'eyedropper'], ['/autoverification', 'Autoverification', 'check2-circle'], ['/reports/turnaround', 'Turnaround', 'stopwatch'], ['/reports/workload', 'Workload', 'bar-chart']]],
  ['setup', 'Set-up', [['/instruments', 'Instruments', 'cpu'], ['/catalogue', 'Catalogue', 'journal-medical'], ['/hmis', 'HMIS link', 'hospital']]],
  ['admin', 'Administration', [['/audit', 'Audit', 'shield-check', (r) => r.includes('auditor')], ['/users', 'Users', 'person-gear', (r) => r.includes('admin')]]],
];

const URGENT = new Set(['/critical', '/failed']);

/**
 * The menu for these roles, with the link for this path marked (the longest
 * matching prefix wins) and the count of work waiting beside a link, if any.
 */
export function navFor(path: string, roles: readonly string[], counts: Partial<Record<string, number>> = {}): NavGroup[] {
  const all = GROUPS.flatMap(([, , items]) => items.map(([href]) => href));
  const matches = (href: string) => (href === '/' ? path === '/' : path === href || path.startsWith(`${href}/`));
  const best = all.filter(matches).sort((a, b) => b.length - a.length)[0];
  return GROUPS.map(([key, label, items]) => {
    const links = items.filter(([, , , show]) => !show || show(roles)).map(([href, text, icon]) => {
      const n = counts[href];
      return { href, label: text, icon, active: href === best, ...(n ? { count: n, countTone: URGENT.has(href) ? 'danger' : 'secondary' } : {}) };
    });
    return { key, label, links, current: links.some((l) => l.active) };
  }).filter((g) => g.links.length > 0);
}

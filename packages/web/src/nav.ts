/**
 * The left-hand menu (09 §1): links grouped by the lab's work, shown by role.
 * Built here rather than in the template so the current page is marked once.
 */
export interface NavLink {
  href: string;
  label: string;
  active: boolean;
}
export interface NavGroup {
  label: string;
  links: NavLink[];
}

type Item = [href: string, label: string, show?: (roles: readonly string[]) => boolean];

const GROUPS: [string, Item[]][] = [
  ['Overview', [['/', 'Dashboard']]],
  ['Specimens', [['/orders', 'Orders'], ['/patients', 'Patients'], ['/worksheet', 'Worksheet'], ['/downtime', 'Downtime']]],
  ['Results', [['/results', 'Results'], ['/critical', 'Critical'], ['/unmatched', 'Unmatched'], ['/failed', 'Failed deliveries']]],
  ['Quality', [['/qc', 'QC'], ['/worksheet/qc', 'Manual QC'], ['/autoverification', 'Autoverification'], ['/reports/turnaround', 'Turnaround'], ['/reports/workload', 'Workload']]],
  ['Set-up', [['/instruments', 'Instruments'], ['/catalogue', 'Catalogue'], ['/hmis', 'HMIS link']]],
  ['Administration', [['/audit', 'Audit', (r) => r.includes('auditor')], ['/users', 'Users', (r) => r.includes('admin')]]],
];

/** The menu for these roles, with the link for this path marked (the longest matching prefix wins). */
export function navFor(path: string, roles: readonly string[]): NavGroup[] {
  const all = GROUPS.flatMap(([, items]) => items.map(([href]) => href));
  const matches = (href: string) => (href === '/' ? path === '/' : path === href || path.startsWith(`${href}/`));
  const best = all.filter(matches).sort((a, b) => b.length - a.length)[0];
  return GROUPS.map(([label, items]) => ({
    label,
    links: items.filter(([, , show]) => !show || show(roles)).map(([href, text]) => ({ href, label: text, active: href === best })),
  })).filter((g) => g.links.length > 0);
}

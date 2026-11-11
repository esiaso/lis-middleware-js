import { navFor } from './nav.js';

/**
 * Breadcrumbs for the page header (09 §1): Dashboard, then the pages above
 * this one, then this page's title (shown as the current item, not a link).
 * The pages above come from the address; a few pages say who their parent is
 * because the address does not (a specimen belongs to an order).
 */
export interface Crumb {
  href: string;
  label: string;
}

type Data = Record<string, unknown>;
type Rule = [pattern: RegExp, parents: (m: RegExpMatchArray, data: Data) => Crumb[]];

const NAV_LABEL = new Map(navFor('/', ['admin', 'auditor']).flatMap((g) => g.links.map((l) => [l.href, l.label] as const)));
const top = (href: string): Crumb => ({ href, label: NAV_LABEL.get(href) ?? href });
const field = (data: Data, key: string, name: string): string => {
  const v = (data[key] as Record<string, unknown> | undefined)?.[name];
  return typeof v === 'string' ? v : '';
};
const orderOf = (data: Data, key: string): Crumb[] => {
  const id = field(data, key, 'orderId');
  return id ? [{ href: `/orders/${encodeURIComponent(id)}`, label: `Order ${field(data, key, 'hmisOrderId')}`.trim() }] : [];
};

const RULES: Rule[] = [
  [/^\/orders\/[^/]+$/, () => [top('/orders')]],
  [/^\/orders\/([^/]+)\/report$/, (m, d) => [top('/orders'), { href: `/orders/${m[1]}`, label: `Order ${field(d, 'o', 'hmisOrderId')}`.trim() }]],
  [/^\/specimens\/([^/]+)$/, (_m, d) => [top('/orders'), ...orderOf(d, 's')]],
  [/^\/specimens\/([^/]+)\/label$/, (m, d) => [top('/orders'), ...orderOf(d, 's'), { href: `/specimens/${m[1]}`, label: 'Specimen' }]],
  [/^\/results\/[^/]+$/, () => [top('/results')]],
  [/^\/(reference-ranges|standard-comments)$/, () => [top('/results')]],
  [/^\/patients\/[^/]+$/, () => [top('/patients')]],
  [/^\/instruments\/[^/]+$/, () => [top('/instruments')]],
  [/^\/instruments\/([^/]+)\/(edit|mappings\/edit)$/, (m) => [top('/instruments'), { href: `/instruments/${m[1]}`, label: decodeURIComponent(m[1]!) }]],
  [/^\/users\/[^/]+$/, () => [top('/users')]],
  [/^\/unmatched\/[^/]+$/, () => [top('/unmatched')]],
  [/^\/critical\/[^/]+$/, () => [top('/critical')]],
  [/^\/catalogue\/(new|[^/]+\/edit)$/, () => [top('/catalogue')]],
  [/^\/delta-checks$/, () => [top('/autoverification')]],
  [/^\/qc\/(ranges|summary)$/, () => [top('/qc')]],
  [/^\/qc\/ranges\/[^/]+\/chart$/, () => [top('/qc'), { href: '/qc/ranges', label: 'QC ranges' }]],
  [/^\/reports\/(overdue|targets)$/, () => [top('/reports/turnaround')]],
  [/^\/downtime\/.+$/, () => [top('/downtime')]],
  [/^\/send-outs\/[^/]+$/, () => [top('/send-outs')]],
  [/^\/referral-labs\/[^/]+$/, () => [top('/referral-labs')]],
];

export function crumbsFor(path: string, data: Data): Crumb[] {
  if (path === '/') return [];
  const rule = RULES.find(([re]) => re.test(path));
  const parents = rule ? rule[1](path.match(rule[0])!, data) : [];
  return [{ href: '/', label: 'Dashboard' }, ...parents];
}

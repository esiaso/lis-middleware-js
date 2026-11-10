/**
 * Paging for long lists (09 §1): a fixed page size, the page asked for in
 * the address (`?page=2`), and the links to the pages around it, keeping
 * the list's other filters. A page past the end shows the last page.
 */
export const PAGE_SIZE = 50;

export interface Pager {
  page: number;
  pages: number;
  total: number;
  from: number;
  to: number;
  prev: string;
  next: string;
  links: { n: number; href: string; current: boolean; gap: boolean }[];
}

/** The page number asked for: a whole number from 1, anything else is page 1. */
export function pageParam(p: unknown): number {
  const n = typeof p === 'string' && /^\d{1,6}$/.test(p) ? Number(p) : 1;
  return n >= 1 ? n : 1;
}

/** The page actually shown (never past the last) and its offset. */
export function pageWindow(asked: number, total: number, size = PAGE_SIZE): { page: number; skip: number } {
  const pages = Math.max(1, Math.ceil(total / size));
  const page = Math.min(asked, pages);
  return { page, skip: (page - 1) * size };
}

/** The pager for one list. `params` are the list's other filters, kept on every link; empty ones are left out. */
export function pagerFor(path: string, params: Record<string, string | undefined>, page: number, total: number, size = PAGE_SIZE): Pager {
  const pages = Math.max(1, Math.ceil(total / size));
  const href = (n: number) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
    if (n > 1) q.set('page', String(n));
    const s = q.toString();
    return s ? `${path}?${s}` : path;
  };
  // First, last, and two either side of the current page; a gap marks the pages left out.
  const shown = [...new Set([1, pages, page - 2, page - 1, page, page + 1, page + 2])].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
  const links = shown.map((n, i) => ({ n, href: href(n), current: n === page, gap: i > 0 && n - shown[i - 1]! > 1 }));
  return {
    page,
    pages,
    total,
    from: total ? (page - 1) * size + 1 : 0,
    to: Math.min(page * size, total),
    prev: page > 1 ? href(page - 1) : '',
    next: page < pages ? href(page + 1) : '',
    links,
  };
}

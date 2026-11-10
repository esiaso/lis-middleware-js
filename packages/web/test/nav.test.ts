import { describe, expect, it } from 'vitest';
import { navFor } from '../src/nav.js';

const active = (path: string, roles: string[] = ['admin']) =>
  navFor(path, roles).flatMap((g) => g.links.filter((l) => l.active).map((l) => l.href));

describe('left-hand menu', () => {
  it('marks the longest matching link, so a sub-page lights its own entry', () => {
    expect(active('/')).toEqual(['/']);
    expect(active('/worksheet/qc')).toEqual(['/worksheet/qc']);
    expect(active('/worksheet')).toEqual(['/worksheet']);
    expect(active('/critical/limits')).toEqual(['/critical']);
    expect(active('/qcx')).toEqual([]);
  });

  it('shows Audit and Users only to the roles that can open them, and drops an empty group', () => {
    const labels = (roles: string[]) => navFor('/', roles).map((g) => g.label);
    expect(labels(['tech'])).not.toContain('Administration');
    expect(navFor('/', ['auditor']).find((g) => g.label === 'Administration')?.links.map((l) => l.href)).toEqual(['/audit']);
    expect(navFor('/', ['admin', 'auditor']).find((g) => g.label === 'Administration')?.links.map((l) => l.href)).toEqual(['/audit', '/users']);
  });
});

describe('menu groups and icons', () => {
  it('marks the group holding the current page, so it is never shown folded', () => {
    const groups = navFor('/worksheet/qc', ['tech']);
    expect(groups.filter((g) => g.current).map((g) => g.key)).toEqual(['quality']);
    expect(navFor('/account/password', ['tech']).some((g) => g.current)).toBe(false);
  });

  it('draws icons from one local sprite, and refuses a name that is not in it', async () => {
    const { iconSprite, iconSvg, ICONS } = await import('../src/icons.js');
    expect(iconSvg('speedometer2')).toBe('<svg class="bi" aria-hidden="true" focusable="false"><use href="/static/icons.svg#speedometer2"></use></svg>');
    expect(() => iconSvg('../package')).toThrow('unknown icon');
    const sprite = iconSprite();
    for (const name of ICONS) expect(sprite).toContain(`<symbol id="${name}" viewBox="0 0 16 16"><path`);
    expect(sprite).not.toContain('style=');
    for (const g of navFor('/', ['admin', 'auditor'])) for (const l of g.links) expect(ICONS.has(l.icon)).toBe(true);
  });
});

describe('menu counts', () => {
  it('puts the count of waiting work beside a link, in red for calls and failures, and nothing for zero', () => {
    const links = navFor('/', ['tech'], { '/critical': 2, '/unmatched': 3, '/failed': 0 }).flatMap((g) => g.links);
    const by = (href: string) => links.find((l) => l.href === href)!;
    expect([by('/critical').count, by('/critical').countTone]).toEqual([2, 'danger']);
    expect([by('/unmatched').count, by('/unmatched').countTone]).toEqual([3, 'secondary']);
    expect(by('/failed').count).toBeUndefined();
    expect(by('/orders').count).toBeUndefined();
  });
});

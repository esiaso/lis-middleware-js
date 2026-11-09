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

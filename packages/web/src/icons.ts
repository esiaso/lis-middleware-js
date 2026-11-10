import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { navFor } from './nav.js';

/**
 * Bootstrap Icons (MIT), taken from the installed package into one small
 * sprite served at /static/icons.svg, so nothing comes from the internet and
 * pages carry only a short reference per icon. Icons are decorative: hidden
 * from screen readers, the text beside them says what they mean.
 */
const dir = join(dirname(createRequire(import.meta.url).resolve('bootstrap-icons/package.json')), 'icons');

/** Every icon the pages use: the menu's, and these. A name outside the list is refused. */
const PAGE_ICONS = [
  'box-arrow-right', 'check2-circle', 'printer', 'chevron-down', 'cloud-slash', 'cpu', 'exclamation-triangle-fill', 'graph-down-arrow', 'hospital', 'list', 'stopwatch',
  // dashboard tiles
  'inbox', 'patch-check', 'send', 'question-diamond', 'x-octagon',
];
export const ICONS: ReadonlySet<string> = new Set([...PAGE_ICONS, ...navFor('/', ['admin', 'auditor']).flatMap((g) => g.links.map((l) => l.icon))]);

export const ICON_SPRITE_PATH = '/static/icons.svg';

let sprite: string | undefined;
/** The sprite: one <symbol> per icon, ids as the icon names. Built once. */
export function iconSprite(): string {
  sprite ??= `<svg xmlns="http://www.w3.org/2000/svg">${[...ICONS]
    .sort()
    .map((name) => {
      const svg = readFileSync(join(dir, `${name}.svg`), 'utf8');
      const viewBox = /viewBox="([^"]+)"/.exec(svg)?.[1] ?? '0 0 16 16';
      const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace(/\s*\n\s*/g, '');
      return `<symbol id="${name}" viewBox="${viewBox}">${inner}</symbol>`;
    })
    .join('')}</svg>`;
  return sprite;
}

/** The markup for one icon. */
export function iconSvg(name: string): string {
  if (!ICONS.has(name)) throw new Error(`unknown icon "${name.slice(0, 64)}"`);
  return `<svg class="bi" aria-hidden="true" focusable="false"><use href="${ICON_SPRITE_PATH}#${name}"></use></svg>`;
}

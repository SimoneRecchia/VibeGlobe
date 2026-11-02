// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * The tour's frame over the globe: a rail of chapters and a glass panel with the scene's tabs, summary, live controls,
 * code and guide. Beside the map on wide screens, a sheet at the bottom on phones. It takes the colors of the
 * `@vibeglobe/ui` theme through `THEME_VARIABLES`, so it follows the controls' light and dark themes.
 */
import { THEME_VARIABLES, type ThemeName } from '@vibeglobe/ui';
import { CHAPTERS, guideUrl, SCENES } from './catalog.js';
import { highlight } from './highlight.js';
import { icon } from './icons.js';
import { button, element } from './panel.js';
import type { SceneEntry } from './types.js';
import './shell.css';

/** The frame's parts a tour changes. */
export interface Shell {
  /** Where the scene builds its controls. */
  readonly body: HTMLElement;
  /** Shows a scene's place, title, summary and guide, with an empty body. */
  show(entry: SceneEntry): void;
  /** Shows the scene's example code. */
  code(text: string): void;
  /** A line under the summary (loading, an error); undefined hides it. */
  status(text: string | undefined, error?: boolean): void;
  setTheme(theme: ThemeName): void;
  setBackend(name: string): void;
}

const hrefOf = (id: string): string => `#scene=${id}`;
/** Phones: the frame is a sheet at the bottom (`shell.css`). */
const NARROW = matchMedia('(max-width: 760px)');

/** The rail: the brand, one link per chapter (to its first scene) and the button that folds the panel. */
function rail(fold: HTMLButtonElement): HTMLElement {
  const nav = element('nav', 'tour-rail');
  nav.setAttribute('aria-label', 'Chapters');
  const brand = element('a', 'tour-brand');
  brand.href = hrefOf('globe');
  brand.title = 'VibeGlobe';
  brand.append(icon('logo'));
  nav.append(brand);
  for (const [id, title] of CHAPTERS) {
    const first = SCENES.find((scene) => scene.chapter === id);
    const link = element('a', 'tour-chapter');
    link.href = hrefOf(first?.id ?? 'globe');
    link.dataset['chapter'] = id;
    link.append(icon(id), element('span', '', title));
    nav.append(link);
  }
  nav.append(fold);
  return nav;
}

/** The scene's previous and next scenes, across chapters. */
function neighbours(entry: SceneEntry): HTMLElement[] {
  const index = SCENES.indexOf(entry);
  const links: HTMLElement[] = [];
  for (const [offset, text] of [
    [-1, '← '],
    [1, ' →'],
  ] as const) {
    const scene = SCENES[index + offset];
    if (!scene) {
      links.push(element('span'));
      continue;
    }
    const link = element('a', 'tour-step', offset < 0 ? `${text}${scene.title}` : `${scene.title}${text}`);
    link.href = hrefOf(scene.id);
    links.push(link);
  }
  return links;
}

/** The code block with its copy button. */
function codeBlock(): { details: HTMLDetailsElement; set(text: string): void } {
  const details = element('details', 'tour-code');
  const summary = element('summary', '', 'Code');
  const pre = element('pre');
  const code = element('code');
  let text = '';
  const copy = button('Copy', () => void navigator.clipboard?.writeText(text), 'tour-code__copy');
  pre.append(code);
  details.append(summary, copy, pre);
  return {
    details,
    set(next) {
      text = next;
      code.replaceChildren(...highlight(next));
      details.hidden = next === '';
    },
  };
}

/**
 * Keeps `--tour-width` and `--tour-height` on the container: the UI's corners stay clear of the frame, of the folded
 * sheet on phones (an unfolded sheet covers the bottom corners while it is read).
 */
function watchSize(frame: HTMLElement, container: HTMLElement): void {
  new ResizeObserver(() => {
    const box = frame.getBoundingClientRect();
    const host = container.getBoundingClientRect();
    container.style.setProperty('--tour-width', `${Math.round(box.right - host.left)}px`);
    if (frame.classList.contains('tour--folded') || !NARROW.matches)
      container.style.setProperty('--tour-height', `${Math.round(host.bottom - box.top)}px`);
  }).observe(frame);
}

/** The panel's elements. */
interface Parts {
  readonly frame: HTMLElement;
  readonly eyebrow: HTMLElement;
  readonly title: HTMLElement;
  readonly badge: HTMLElement;
  readonly themeButton: HTMLButtonElement;
  readonly tabs: HTMLElement;
  readonly scroll: HTMLElement;
  readonly summary: HTMLElement;
  readonly status: HTMLElement;
  readonly body: HTMLElement;
  readonly code: ReturnType<typeof codeBlock>;
  readonly guide: HTMLAnchorElement;
  readonly steps: HTMLElement;
}

/** The frame's elements, assembled; `fold` folds and unfolds the panel. */
function build(fold: (on?: boolean) => void, setTheme: () => void): Parts {
  const frame = element('aside', 'tour');
  frame.setAttribute('aria-label', 'VibeGlobe tour');
  const panel = element('section', 'tour-panel');
  const head = element('header', 'tour-head');
  const titles = element('div', 'tour-titles');
  const parts: Parts = {
    frame,
    eyebrow: element('p', 'tour-eyebrow'),
    title: element('h1', 'tour-title'),
    badge: element('span', 'tour-badge'),
    themeButton: button('', setTheme, 'tour-icon-button'),
    tabs: element('nav', 'tour-tabs'),
    scroll: element('div', 'tour-scroll'),
    summary: element('p', 'tour-summary'),
    status: element('p', 'tour-status'),
    body: element('div', 'tour-body'),
    code: codeBlock(),
    guide: element('a', 'tour-guide'),
    steps: element('footer', 'tour-steps'),
  };
  const foldButton = button('', () => fold(), 'tour-icon-button tour-fold');
  foldButton.append(icon('collapse'));
  parts.tabs.setAttribute('aria-label', 'Scenes');
  parts.guide.target = '_blank';
  parts.guide.rel = 'noopener';
  titles.append(parts.eyebrow, parts.title);
  head.append(titles, parts.badge, parts.themeButton);
  parts.scroll.append(parts.summary, parts.status, parts.body, parts.code.details, parts.guide);
  panel.append(head, parts.tabs, parts.scroll, parts.steps);
  frame.append(rail(foldButton), panel);
  return parts;
}

/** Shows `entry` in the frame: its chapter in the rail, its place, tabs, summary, guide and neighbours. */
function showScene(parts: Parts, entry: SceneEntry): void {
  const chapter = CHAPTERS.find(([id]) => id === entry.chapter);
  const siblings = SCENES.filter((scene) => scene.chapter === entry.chapter);
  for (const link of parts.frame.querySelectorAll<HTMLElement>('.tour-chapter'))
    link.toggleAttribute('aria-current', link.dataset['chapter'] === entry.chapter);
  parts.eyebrow.textContent = `${chapter?.[1] ?? ''} · ${String(siblings.indexOf(entry) + 1)} of ${String(siblings.length)}`;
  parts.title.textContent = entry.title;
  parts.tabs.replaceChildren(
    ...siblings.map((scene) => {
      const tab = element('a', 'tour-tab', scene.title);
      tab.href = hrefOf(scene.id);
      if (scene === entry) tab.setAttribute('aria-current', 'page');
      return tab;
    }),
  );
  parts.summary.textContent = entry.summary;
  parts.guide.href = guideUrl(entry.guide);
  parts.guide.textContent = `Guide: ${entry.guide.replace(/^.*\//, '').replace(/\.md(#.*)?$/, '')} ↗`;
  parts.steps.replaceChildren(...neighbours(entry));
  parts.body.replaceChildren();
  parts.code.set('');
  parts.scroll.scrollTop = 0;
}

/** Builds the frame in `container`, the globe's. Narrow screens start with the panel folded. */
export function createShell(container: HTMLElement, theme: ThemeName, setTheme: (theme: ThemeName) => void): Shell {
  const fold = (on = !parts.frame.classList.contains('tour--folded')): void => {
    parts.frame.classList.toggle('tour--folded', on);
    const button = parts.frame.querySelector('.tour-fold');
    button?.setAttribute('aria-expanded', String(!on));
    button?.setAttribute('aria-label', on ? 'Show the panel' : 'Hide the panel');
  };
  const parts = build(fold, () => setTheme(parts.frame.dataset['theme'] === 'dark' ? 'light' : 'dark'));
  container.append(parts.frame);
  watchSize(parts.frame, container);
  fold(NARROW.matches);
  const shell: Shell = {
    body: parts.body,
    show: (entry) => showScene(parts, entry),
    code: (text) => parts.code.set(text),
    status(text, error = false) {
      parts.status.textContent = text ?? '';
      parts.status.hidden = text === undefined;
      parts.status.classList.toggle('tour-status--error', error);
    },
    setTheme(next) {
      parts.frame.dataset['theme'] = next;
      for (const [name, value] of Object.entries(THEME_VARIABLES[next])) parts.frame.style.setProperty(name, value);
      parts.themeButton.textContent = next === 'dark' ? '☀' : '☾';
      parts.themeButton.setAttribute('aria-label', next === 'dark' ? 'Light mode' : 'Dark mode');
    },
    setBackend: (name) => void (parts.badge.textContent = name),
  };
  shell.setTheme(theme);
  return shell;
}

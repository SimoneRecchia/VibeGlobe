// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/** DOM helpers shared by the built-in controls. */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** An icon from one or more SVG paths on a 24-unit grid; `className` per path lets a theme color parts. */
export function icon(...paths: readonly (string | readonly [d: string, className: string])[]): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const entry of paths) {
    const path = document.createElementNS(SVG_NS, 'path');
    const [d, className] = typeof entry === 'string' ? [entry, undefined] : entry;
    path.setAttribute('d', d);
    if (className !== undefined) path.setAttribute('class', className);
    svg.append(path);
  }
  return svg;
}

/** A square icon button of the control style. */
export function iconButton(name: string, svg: SVGSVGElement): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `vg-ui__button vg-ui__button--${name}`;
  button.append(svg);
  return button;
}

/** The frame of a control: a group with the control style. */
export function controlFrame(name: string): HTMLDivElement {
  const frame = document.createElement('div');
  frame.className = `vg-ui__control vg-ui__${name}`;
  return frame;
}

/** Sets a button's accessible name and tooltip. */
export function label(element: HTMLElement, text: string, title = text): void {
  element.setAttribute('aria-label', text);
  element.title = title;
}

/** Icon paths, drawn for this package. */
export const ICONS = {
  plus: 'M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z',
  minus: 'M5 11h14v2H5z',
  enterFullscreen: 'M4 4h6v2H6v4H4zM14 4h6v6h-2V6h-4zM4 14h2v4h4v2H4zM18 14h2v6h-6v-2h4z',
  exitFullscreen: 'M8 4h2v6H4V8h4zM14 4h2v4h4v2h-6zM4 14h6v6H8v-4H4zM14 14h6v2h-4v4h-2z',
  debug: 'M4 18h16v2H4zM6 9h2v7H6zM11 4h2v12h-2zM16 11h2v5h-2z',
  compassNorth: 'M12 2.5l4.5 9.5h-9z',
  compassSouth: 'M7.5 12h9L12 21.5z',
  format: 'M4 6h16v2H4zM4 11h10v2H4zM4 16h13v2H4z',
  globe:
    'M12 2a10 10 0 100 20 10 10 0 000-20zm6.9 9h-3a15 15 0 00-1.3-6A8 8 0 0118.9 11zM12 4c1 1.2 1.8 3.8 2 7h-4c.2-3.2 1-5.8 2-7zM9.4 5a15 15 0 00-1.3 6h-3A8 8 0 019.4 5zm-4.3 8h3a15 15 0 001.3 6A8 8 0 015.1 13zM12 20c-1-1.2-1.8-3.8-2-7h4c-.2 3.2-1 5.8-2 7zm2.6-1a15 15 0 001.3-6h3a8 8 0 01-4.3 6z',
  home: 'M12 3l9 8h-3v9h-5v-6h-2v6H6v-9H3z',
  layers:
    'M12 3l10 5-10 5L2 8zM4.2 11.6L12 15.5l7.8-3.9 2.2 1.1-10 5-10-5zM4.2 15.6L12 19.5l7.8-3.9 2.2 1.1-10 5-10-5z',
  locate:
    'M11 2h2v3.1A7 7 0 0118.9 11H22v2h-3.1a7 7 0 01-5.9 5.9V22h-2v-3.1A7 7 0 015.1 13H2v-2h3.1A7 7 0 0111 5.1zm1 5a5 5 0 100 10 5 5 0 000-10zm0 3a2 2 0 110 4 2 2 0 010-4z',
  bookmark: 'M6 3h12v18l-6-4-6 4z',
  camera:
    'M9 4h6l2 2h3a1 1 0 011 1v12a1 1 0 01-1 1H4a1 1 0 01-1-1V7a1 1 0 011-1h3zm3 4a5 5 0 100 10 5 5 0 000-10zm0 2a3 3 0 110 6 3 3 0 010-6z',
  info: 'M11 10h2v8h-2zM12 6a1.3 1.3 0 110 2.6A1.3 1.3 0 0112 6z',
  point: 'M12 7a5 5 0 110 10 5 5 0 010-10z',
  line: 'M4 18.6L17.6 5 19 6.4 5.4 20z',
  polygon: 'M12 3l9 7-3.5 10h-11L3 10zm0 2.5L5.3 10.7 8 18h8l2.7-7.3z',
  edit: 'M15.6 3.6l4.8 4.8L9 19.8H4.2V15zM6.2 15.8V17.8h2l8.4-8.4-2-2z',
  ruler:
    'M2 16L16 2l6 6L8 22zm3 0l3 3 1.4-1.4-1.5-1.5 1-1 1.5 1.5 1.4-1.4-1.5-1.5 1-1 1.5 1.5 1.4-1.4-1.5-1.5 1-1 1.5 1.5L19 8l-3-3z',
  area: 'M3 3h7v2H5v5H3zM14 3h7v7h-2V5h-5zM3 14h2v5h5v2H3zM19 14h2v7h-7v-2h5z',
  trash: 'M9 3h6l1 2h4v2H4V5h4zM6 9h12l-1 12H7z',
  check: 'M9 16.2l-3.5-3.5L4 14.1 9 19 20 8l-1.4-1.4z',
  close: 'M6.4 5L12 10.6 17.6 5 19 6.4 13.4 12 19 17.6 17.6 19 12 13.4 6.4 19 5 17.6 10.6 12 5 6.4z',
} as const;

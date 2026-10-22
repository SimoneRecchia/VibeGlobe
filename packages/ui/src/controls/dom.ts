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
} as const;

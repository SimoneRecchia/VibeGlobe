// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/** The tour's line icons, 24 × 24, drawn in the text color. */
import type { ChapterId } from './types.js';

const PATHS: Readonly<Record<ChapterId | 'logo' | 'collapse', string>> = {
  logo: '<circle cx="12" cy="12" r="7.5"/><ellipse cx="12" cy="12" rx="11" ry="3.6" transform="rotate(-24 12 12)"/>',
  collapse: '<path d="m15 6-6 6 6 6"/>',
  earth: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3.4 3.4 3.4 14.6 0 18M12 3c-3.4 3.4-3.4 14.6 0 18"/>',
  views:
    '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  imagery: '<path d="M12 3 2.5 8 12 13l9.5-5z"/><path d="m2.5 12.2 9.5 5 9.5-5M2.5 16.4l9.5 5 9.5-5"/>',
  terrain: '<path d="m2 20 6.5-11 4 6 3-4.5L22 20z"/><path d="m7 11.5 1.5 1.3 1.6-1.2"/>',
  vector: '<path d="M9 4 3 6.2v13.8l6-2.2 6 2.2 6-2.2V4l-6 2.2z"/><path d="M9 4v13.8M15 6.2V20"/>',
  data: '<path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.4"/>',
  models: '<path d="m12 2.5 8.5 4.8v9.4L12 21.5l-8.5-4.8V7.3z"/><path d="m3.5 7.3 8.5 4.8 8.5-4.8M12 12.1v9.4"/>',
  tools: '<path d="M3.5 16.5 16.5 3.5l4 4-13 13z"/><path d="m7.5 12.5 2 2m1.5-5.5 2 2m1.5-5.5 2 2"/>',
  offline:
    '<path d="M7 17.5a4.5 4.5 0 0 1-.6-9 6 6 0 0 1 11.5 1.6A3.8 3.8 0 0 1 17.5 17.5"/><path d="M12 11v9m-3-3 3 3 3-3"/>',
  performance: '<path d="M3.5 17.5a8.5 8.5 0 1 1 17 0"/><path d="m12 17.5 4.2-5.6"/><circle cx="12" cy="17.5" r="1"/>',
  integrations: '<path d="m8 7-5 5 5 5M16 7l5 5-5 5M13.5 4.5l-3 15"/>',
};

/** An icon as an inline SVG element, hidden from assistive technology (its control carries the name). */
export function icon(name: keyof typeof PATHS): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('tour-icon');
  svg.innerHTML = PATHS[name];
  return svg;
}

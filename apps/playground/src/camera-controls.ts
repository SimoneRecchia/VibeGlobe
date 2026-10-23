import type { NavigationControls } from '@vibeglobe/controls';
import type { Globe } from '@vibeglobe/core';

/** The orientation commands (F191): the heading each button turns to. */
const ORIENTATIONS: readonly { readonly label: string; readonly headingDeg: number }[] = [
  { label: 'N', headingDeg: 0 },
  { label: 'E', headingDeg: 90 },
  { label: 'S', headingDeg: 180 },
  { label: 'W', headingDeg: 270 },
];

function button(label: string, name: string, onClick: () => void): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.textContent = label;
  element.dataset['command'] = name;
  element.addEventListener('click', onClick);
  return element;
}

/**
 * The playground's camera commands (M6): zoom in and out by one level about the center (F174), a tilt slider (F188), north, east, south and west (F191), reset to the globe
 * (F193) and home (F194). Each calls the public movement API; the slider follows the applied tilt.
 */
export function showCameraControls(globe: Globe, app: HTMLElement, navigation: NavigationControls): void {
  const group = document.createElement('div');
  group.id = 'camera-controls';
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', 'Camera');
  group.append(
    button('+', 'zoom-in', () => navigation.zoomIn()),
    button('−', 'zoom-out', () => navigation.zoomOut()),
  );
  const tilt = document.createElement('input');
  tilt.type = 'range';
  tilt.min = '0';
  tilt.max = '85';
  tilt.step = '1';
  tilt.setAttribute('aria-label', 'Tilt');
  tilt.addEventListener('change', () => void globe.tiltTo(Number(tilt.value)));
  globe.on('camera-change', ({ tiltDeg }) => {
    if (document.activeElement !== tilt) tilt.value = String(Math.round(tiltDeg));
  });
  group.append(tilt);
  for (const { label, headingDeg } of ORIENTATIONS)
    group.append(button(label, `face-${label.toLowerCase()}`, () => void globe.rotateTo(headingDeg)));
  group.append(
    button('Globe', 'reset-to-globe', () => void globe.resetToGlobe()),
    button('Home', 'home', () => void globe.goHome()),
  );
  app.append(group);
}

import type { GeoPosition, Globe, ScreenPoint } from '@vibeglobe/core';

/** A click on the globe: where it landed on the element and on the ellipsoid (undefined in space). */
export interface GlobeClickEvent {
  readonly point: ScreenPoint;
  readonly position: GeoPosition | undefined;
}

/** A press and release closer than this, in CSS pixels, is a click; a longer move is a drag. */
const CLICK_SLOP_PX = 4;
/** A press held longer than this is not a click. */
const CLICK_MAX_MS = 500;

/**
 * Reports clicks (a press and release in place, primary button) on the element as positions on the globe. Returns the
 * function that stops listening.
 */
export function watchClicks(element: HTMLElement, globe: Globe, onClick: (event: GlobeClickEvent) => void): () => void {
  let downX = 0;
  let downY = 0;
  let downMs = -1;
  const down = (event: PointerEvent): void => {
    downMs = event.button === 0 && event.isPrimary ? event.timeStamp : -1;
    downX = event.clientX;
    downY = event.clientY;
  };
  const up = (event: PointerEvent): void => {
    if (downMs < 0 || event.timeStamp - downMs > CLICK_MAX_MS) return;
    if (Math.hypot(event.clientX - downX, event.clientY - downY) > CLICK_SLOP_PX) return;
    downMs = -1;
    const box = element.getBoundingClientRect();
    const point = { xPx: event.clientX - box.left, yPx: event.clientY - box.top };
    onClick({ point, position: globe.screenToGeo(point) });
  };
  element.addEventListener('pointerdown', down);
  element.addEventListener('pointerup', up);
  return () => {
    element.removeEventListener('pointerdown', down);
    element.removeEventListener('pointerup', up);
  };
}

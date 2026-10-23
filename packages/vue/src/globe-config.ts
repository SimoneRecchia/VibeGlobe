import type { NavigationControls } from '@vibeglobe/controls';
import type { GeoPosition, Globe, GlobeOptions, ImagerySource, ScreenPoint, ViewInit } from '@vibeglobe/core';
import { createRenderer, type BackendChoice } from '@vibeglobe/renderer';
import { createWorkers } from '@vibeglobe/worker';

/** Engine options the component passes through unchanged (everything it does not build itself). */
export type GlobeExtraOptions = Omit<
  GlobeOptions,
  'container' | 'renderer' | 'controls' | 'baseImageryUrl' | 'view' | 'imagery' | 'workers'
>;

/** What the component needs to start an engine: its props, resolved. */
export interface GlobeConfig {
  readonly baseImageryUrl: string;
  readonly backend: BackendChoice;
  readonly controls: boolean;
  readonly view: ViewInit;
  readonly imagery?: readonly ImagerySource[] | undefined;
  readonly workers?: GlobeOptions['workers'];
  readonly options?: GlobeExtraOptions | undefined;
}

/**
 * The engine options for a configuration: a renderer in the container, the default navigation controls, and the
 * engine's bundled workers when imagery sources need decoding and the host passes none.
 */
export function globeOptions(
  container: HTMLElement,
  config: GlobeConfig,
  controls: NavigationControls | undefined,
): GlobeOptions {
  const imagery = config.imagery ?? [];
  const workers = config.workers ?? (imagery.length > 0 ? createWorkers() : undefined);
  return {
    ...config.options,
    container,
    renderer: createRenderer({ backend: config.backend }),
    ...(controls ? { controls } : {}),
    baseImageryUrl: config.baseImageryUrl,
    view: config.view,
    ...(imagery.length > 0 ? { imagery } : {}),
    ...(workers ? { workers } : {}),
  };
}

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

/** The view fields that differ from the camera by more than rounding, or undefined when none do. */
export function changedView(camera: Globe['camera'], view: ViewInit): ViewInit | undefined {
  const changed: Record<string, number> = {};
  const fields = [
    ['longitudeDeg', camera.longitudeDeg],
    ['latitudeDeg', camera.latitudeDeg],
    ['zoom', camera.zoom],
    ['headingDeg', camera.headingDeg],
    ['tiltDeg', camera.tiltDeg],
  ] as const;
  for (const [field, current] of fields) {
    const wanted = view[field];
    if (wanted !== undefined && Math.abs(wanted - current) > 1e-9) changed[field] = wanted;
  }
  return Object.keys(changed).length > 0 ? changed : undefined;
}

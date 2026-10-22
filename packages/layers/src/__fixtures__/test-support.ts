/** Shared test helpers: a flat projector, frame contexts and point features. */
import type { GeoPosition, ScreenPoint } from '@vibeglobe/core';
import type { Feature } from '../geojson.js';
import type { FrameContext } from '../layer.js';
import type { ScreenProjector } from '../render-target.js';

/** Equirectangular projection at `pxPerDeg`, hiding longitudes beyond `horizonLonDeg` (the far side of a globe). */
export function flatProjector(
  pxPerDeg = 10,
  zoom = 5,
  horizonLonDeg = 90,
): ScreenProjector & { setZoom(z: number): void } {
  let current = zoom;
  return {
    geoToScreen(p: GeoPosition): ScreenPoint | undefined {
      if (Math.abs(p.longitudeDeg) > horizonLonDeg) return undefined;
      return { xPx: (p.longitudeDeg + 180) * pxPerDeg, yPx: (90 - p.latitudeDeg) * pxPerDeg };
    },
    zoom: () => current,
    setZoom(z: number) {
      current = z;
    },
  };
}

/** A frame context. */
export function frameAt(nowMs: number, zoom: number, projector: ScreenProjector = flatProjector()): FrameContext {
  return { nowMs, zoom, projector };
}

/** A point feature. */
export function point(
  id: string | number,
  lon: number,
  lat: number,
  properties: Record<string, unknown> = {},
): Feature {
  return { type: 'Feature', id, properties, geometry: { type: 'Point', coordinates: [lon, lat] } };
}

/** `count` points on a deterministic pseudo-random spread over the world. */
export function randomPoints(count: number, seed = 1): Feature[] {
  let s = seed >>> 0;
  const next = (): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
  return Array.from({ length: count }, (_, i) => point(i, next() * 360 - 180, next() * 170 - 85, { v: i % 10 }));
}

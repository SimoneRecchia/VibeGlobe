import type { CreditViewport } from '../imagery/credits.js';
import type { GeoPosition, ScreenPoint } from './types.js';
import type { RuntimeCredits } from './runtime-credits.js';
import type { Emitter } from './emitter.js';
import type { GlobeEvents } from './types.js';

/** What the credits of a settled view need of a globe. */
interface SettledGlobe {
  readonly camera: {
    readonly longitudeDeg: number;
    readonly latitudeDeg: number;
    readonly zoom: number;
    readonly headingDeg: number;
    readonly tiltDeg: number;
  };
  screenToGeo(point: ScreenPoint): GeoPosition | undefined;
}

/** Points across the viewport, 5 × 5, whose ground positions bound the visible area. */
const STEPS = 5;

/** The visible area of a view (the ground under a 5 × 5 grid of screen points) and its zoom (F258). */
function creditViewport(globe: SettledGlobe, widthPx: number, heightPx: number): CreditViewport {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (let i = 0; i < STEPS; i++)
    for (let j = 0; j < STEPS; j++) {
      const ground = globe.screenToGeo({ xPx: (widthPx * i) / (STEPS - 1), yPx: (heightPx * j) / (STEPS - 1) });
      if (!ground) continue;
      west = Math.min(west, ground.longitudeDeg);
      east = Math.max(east, ground.longitudeDeg);
      south = Math.min(south, ground.latitudeDeg);
      north = Math.max(north, ground.latitudeDeg);
    }
  const { longitudeDeg, latitudeDeg, zoom } = globe.camera;
  // Nothing of the ground at the sampled points (a far view between them): the point under the camera.
  if (west > east)
    return { zoom, westDeg: longitudeDeg, southDeg: latitudeDeg, eastDeg: longitudeDeg, northDeg: latitudeDeg };
  return { zoom, westDeg: west, southDeg: south, eastDeg: east, northDeg: north };
}

/** The payload of every `idle` event, reused: listeners read it during the call. */
const IDLE_PAYLOAD = { frameNumber: 0 };

/**
 * After a frame that requested no other: asks view-dependent sources for the credits of the view the camera rests at
 * (F258), and emits `idle` once nothing loads either.
 */
export function atRest(
  globe: SettledGlobe,
  frame: { readonly imagery?: { readonly credits: RuntimeCredits } | undefined; readonly loading: boolean },
  emitter: Emitter<GlobeEvents>,
  frameNumber: number,
  viewport: { readonly widthPx: number; readonly heightPx: number },
): void {
  const credits = frame.imagery?.credits;
  if (credits?.viewDependent) {
    const { longitudeDeg, latitudeDeg, zoom, headingDeg, tiltDeg } = globe.camera;
    const { widthPx, heightPx } = viewport;
    credits.settle([longitudeDeg, latitudeDeg, zoom, headingDeg, tiltDeg, widthPx, heightPx], () =>
      creditViewport(globe, widthPx, heightPx),
    );
  }
  if (emitter.has('idle') && !frame.loading) {
    IDLE_PAYLOAD.frameNumber = frameNumber;
    emitter.emit('idle', IDLE_PAYLOAD);
  }
}

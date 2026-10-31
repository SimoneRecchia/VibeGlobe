import type { DebugShape, GeoPosition, Globe } from '@vibeglobe/core';
import { geodesicDirect } from '@vibeglobe/core/geodesy';

/** A point `forwardMeters` along `headingDeg` and `rightMeters` to its right from (lon, lat), at a height. */
function offset(
  origin: { longitudeDeg: number; latitudeDeg: number },
  headingDeg: number,
  forwardMeters: number,
  rightMeters: number,
  heightMeters: number,
): GeoPosition {
  const ahead =
    forwardMeters === 0
      ? { longitudeDeg: origin.longitudeDeg, latitudeDeg: origin.latitudeDeg }
      : geodesicDirect(origin.longitudeDeg, origin.latitudeDeg, headingDeg, forwardMeters);
  const side =
    rightMeters === 0 ? ahead : geodesicDirect(ahead.longitudeDeg, ahead.latitudeDeg, headingDeg + 90, rightMeters);
  return { longitudeDeg: side.longitudeDeg, latitudeDeg: side.latitudeDeg, heightMeters };
}

/**
 * A ground-aligned rectangle along a heading: from `startMeters` to `endMeters` ahead, `widthMeters` wide, centered
 * `rightMeters` to the right of the line through the origin.
 */
function strip(
  origin: { longitudeDeg: number; latitudeDeg: number },
  headingDeg: number,
  startMeters: number,
  endMeters: number,
  widthMeters: number,
  heightMeters: number,
  colorRgb: readonly [number, number, number],
  checkerMeters?: number,
  rightMeters = 0,
): DebugShape {
  const half = widthMeters / 2;
  return {
    corners: [
      offset(origin, headingDeg, startMeters, rightMeters - half, heightMeters),
      offset(origin, headingDeg, startMeters, rightMeters + half, heightMeters),
      offset(origin, headingDeg, endMeters, rightMeters + half, heightMeters),
      offset(origin, headingDeg, endMeters, rightMeters - half, heightMeters),
    ],
    colorRgb,
    ...(checkerMeters === undefined ? {} : { checkerMeters }),
  };
}

/**
 * Street-level jitter (F057): a 4 m checkered quad (5 cm cells) under a camera about 1 m above the ground, so any
 * vertex jitter shows as motion of the checker edges.
 */
function streetLevelJitter(globe: Globe): void {
  // Wheel zooms reach 1 m here: no distance kept from the surface (KB-299 keeps 40 m by default).
  globe.setConstraints({ minSurfaceDistanceMeters: 0 });
  const { longitudeDeg, latitudeDeg } = globe.camera;
  globe.setDebugShapes([strip({ longitudeDeg, latitudeDeg }, 0, -2, 2, 4, 0.01, [0.95, 0.9, 0.2], 0.05)]);
}

/**
 * Depth range (F058, ADR 0005): looking toward the horizon from about 1 m, counted from below the eye, three lanes of
 * quad pairs from 0.5 m to the horizon (about 3.57 km): in each lane a red quad lies 1, 2 or 5 cm above a narrower
 * blue one at 1 cm, in 50 m segments. Red covers blue geometrically everywhere it is drawn, so any blue pixel is a
 * depth-ordering error.
 */
function depthRange(globe: Globe): void {
  const { longitudeDeg, latitudeDeg, headingDeg, tiltDeg, rangeMeters } = globe.camera;
  // Distances count from the point on the ground below the eye, which is behind the target.
  const back = rangeMeters * Math.sin((tiltDeg * Math.PI) / 180);
  const origin =
    back > 0 ? geodesicDirect(longitudeDeg, latitudeDeg, headingDeg + 180, back) : { longitudeDeg, latitudeDeg };
  const shapes: DebugShape[] = [];
  for (const [gapMeters, rightMeters] of [
    [0.01, -2.5],
    [0.02, 0],
    [0.05, 2.5],
  ] as const) {
    for (let start = 0.5; start < HORIZON_METERS; start += 50) {
      const end = Math.min(start + 50, HORIZON_METERS);
      shapes.push(strip(origin, headingDeg, start, end, 2, 0.01 + gapMeters, [0.9, 0.1, 0.1], undefined, rightMeters));
      // The blue quad starts a little farther: a ray grazing the red quad's near edge from 1 m meets the blue one
      // farther away, so from there on red covers blue geometrically.
      const nearest = 0.5 + (0.5 * gapMeters) / 0.96 + 0.05;
      shapes.push(
        strip(
          origin,
          headingDeg,
          Math.max(start, nearest) + 0.02,
          end - 0.02,
          1.6,
          0.01,
          [0.1, 0.2, 0.95],
          undefined,
          rightMeters,
        ),
      );
    }
  }
  globe.setDebugShapes(shapes);
}

/** The horizon distance from about 1 m above the ground: √(2 · R · h) with R = 6371 km. */
const HORIZON_METERS = 3570;

/**
 * F090's camera path: from Milan to Tokyo along the great circle at zoom 7 in 4 s, one step per display frame, then
 * `document.body.dataset['scenario']` becomes `done`. Tiles passed on the way should be cancelled, not loaded.
 */
function pathMilanTokyo(globe: Globe): void {
  const rad = Math.PI / 180;
  const unit = (lonDeg: number, latDeg: number): [number, number, number] => [
    Math.cos(latDeg * rad) * Math.cos(lonDeg * rad),
    Math.cos(latDeg * rad) * Math.sin(lonDeg * rad),
    Math.sin(latDeg * rad),
  ];
  const from = unit(9.19, 45.46);
  const to = unit(139.7, 35.7);
  const angle = Math.acos(from[0] * to[0] + from[1] * to[1] + from[2] * to[2]);
  const durationMs = 4000;
  const startMs = performance.now();
  const advance = (): void => {
    const t = Math.min(1, (performance.now() - startMs) / durationMs);
    const a = Math.sin((1 - t) * angle) / Math.sin(angle);
    const b = Math.sin(t * angle) / Math.sin(angle);
    const [x, y, z] = [0, 1, 2].map((i) => a * (from[i] ?? 0) + b * (to[i] ?? 0)) as [number, number, number];
    globe.jumpTo({ longitudeDeg: Math.atan2(y, x) / rad, latitudeDeg: Math.atan2(z, Math.hypot(x, y)) / rad, zoom: 7 });
    if (t < 1) requestAnimationFrame(advance);
    else document.body.dataset['scenario'] = 'done';
  };
  advance();
}

/** A flight from Milan to Tokyo at zoom 9 (F286, F287, F301); the page's `data-scenario` turns 'done' on arrival. */
function flightMilanTokyo(globe: Globe): void {
  document.body.dataset['scenario'] = 'flying';
  void globe.flyTo({ longitudeDeg: 139.7, latitudeDeg: 35.7, zoom: 9 }).then(() => {
    document.body.dataset['scenario'] = 'done';
  });
}

const SCENARIOS: Readonly<Record<string, (globe: Globe) => void>> = {
  'street-level-jitter': streetLevelJitter,
  'depth-range': depthRange,
  'path-milan-tokyo': pathMilanTokyo,
  'flight-milan-tokyo': flightMilanTokyo,
};

/** Sets up a named scenario once the globe is ready; unknown names do nothing. */
export function runScenario(globe: Globe, name: string | null): void {
  const scenario = name === null ? undefined : SCENARIOS[name];
  if (scenario) void globe.ready.then(() => scenario(globe));
}

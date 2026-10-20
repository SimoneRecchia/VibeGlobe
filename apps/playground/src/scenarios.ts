import { geodesicDirect, type DebugShape, type GeoPosition, type Globe } from '@vibeglobe/core';

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

/** A ground-aligned rectangle along a heading: from `startMeters` to `endMeters` ahead, `widthMeters` wide. */
function strip(
  origin: { longitudeDeg: number; latitudeDeg: number },
  headingDeg: number,
  startMeters: number,
  endMeters: number,
  widthMeters: number,
  heightMeters: number,
  colorRgb: readonly [number, number, number],
  checkerMeters?: number,
): DebugShape {
  const half = widthMeters / 2;
  return {
    corners: [
      offset(origin, headingDeg, startMeters, -half, heightMeters),
      offset(origin, headingDeg, startMeters, half, heightMeters),
      offset(origin, headingDeg, endMeters, half, heightMeters),
      offset(origin, headingDeg, endMeters, -half, heightMeters),
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
  const { longitudeDeg, latitudeDeg } = globe.camera;
  globe.setDebugShapes([strip({ longitudeDeg, latitudeDeg }, 0, -2, 2, 4, 0.01, [0.95, 0.9, 0.2], 0.05)]);
}

/**
 * Depth range (F058): looking toward the horizon from about 1 m, counted from below the eye, a red strip 4 cm above the ground over a narrower blue
 * strip 1 cm above it, both in 50 m segments from 0.5 m to 3 km. Any blue pixel is a depth-ordering error.
 */
function depthRange(globe: Globe): void {
  const { longitudeDeg, latitudeDeg, headingDeg, tiltDeg, rangeMeters } = globe.camera;
  // Distances count from the point on the ground below the eye, which is behind the target.
  const back = rangeMeters * Math.sin((tiltDeg * Math.PI) / 180);
  const origin =
    back > 0 ? geodesicDirect(longitudeDeg, latitudeDeg, headingDeg + 180, back) : { longitudeDeg, latitudeDeg };
  const shapes: DebugShape[] = [];
  for (let start = 0.5; start < 3000; start += 50) {
    const end = Math.min(start + 50, 3000);
    shapes.push(strip(origin, headingDeg, start, end, 2, 0.04, [0.9, 0.1, 0.1]));
    // The blue layer starts at 0.65 m: a ray grazing the red layer's near edge from 1 m reaches the 1 cm layer about
    // 7% farther away, so from there on red geometrically covers blue and any blue pixel is a depth error.
    shapes.push(strip(origin, headingDeg, Math.max(start, 0.65) + 0.02, end - 0.02, 1.6, 0.01, [0.1, 0.2, 0.95]));
  }
  globe.setDebugShapes(shapes);
}

const SCENARIOS: Readonly<Record<string, (globe: Globe) => void>> = {
  'street-level-jitter': streetLevelJitter,
  'depth-range': depthRange,
};

/** Sets up a named scenario once the globe is ready; unknown names do nothing. */
export function runScenario(globe: Globe, name: string | null): void {
  const scenario = name === null ? undefined : SCENARIOS[name];
  if (scenario) void globe.ready.then(() => scenario(globe));
}

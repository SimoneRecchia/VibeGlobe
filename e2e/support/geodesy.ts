// WGS84 conversions for test geometry (a test-side copy kept independent of the engine's own implementation).
const A = 6378137;
const F = 1 / 298.257223563;
const E2 = F * (2 - F);
const DEG = Math.PI / 180;

/** A WGS84 position in degrees and meters. */
interface Geodetic {
  longitudeDeg: number;
  latitudeDeg: number;
  heightMeters: number;
}

/** WGS84 geodetic to Earth-centered, Earth-fixed meters. */
function toEcef(p: Geodetic): Vec3 {
  const lat = p.latitudeDeg * DEG;
  const lon = p.longitudeDeg * DEG;
  const n = A / Math.sqrt(1 - E2 * Math.sin(lat) ** 2);
  const r = (n + p.heightMeters) * Math.cos(lat);
  return [r * Math.cos(lon), r * Math.sin(lon), (n * (1 - E2) + p.heightMeters) * Math.sin(lat)];
}

/** Earth-centered, Earth-fixed meters to WGS84 geodetic (Bowring's iteration, converged to well below a millimeter). */
function fromEcef([x, y, z]: readonly [number, number, number]): Geodetic {
  const lon = Math.atan2(y, x);
  const p = Math.hypot(x, y);
  let lat = Math.atan2(z, p * (1 - E2));
  let height = 0;
  for (let i = 0; i < 8; i++) {
    const n = A / Math.sqrt(1 - E2 * Math.sin(lat) ** 2);
    height = p / Math.cos(lat) - n;
    lat = Math.atan2(z, p * (1 - (E2 * n) / (n + height)));
  }
  return { longitudeDeg: lon / DEG, latitudeDeg: lat / DEG, heightMeters: height };
}

type Vec3 = [number, number, number];

/** The four corners of a quad, in order around it. */
export type Quad = [Geodetic, Geodetic, Geodetic, Geodetic];

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * A quad parallel to a planar quad given by its four corners: in the same plane moved `dropMeters` toward the Earth's
 * center along the plane's normal, scaled about the corners' centroid by `scale`.
 */
export function parallelQuad(corners: Quad, scale: number, dropMeters: number): Quad {
  const points = corners.map(toEcef);
  const [p0, p1, , p3] = points;
  if (!p0 || !p1 || !p3) throw new Error('a quad needs four corners');
  const center = points.reduce<Vec3>((sum, p) => [sum[0] + p[0] / 4, sum[1] + p[1] / 4, sum[2] + p[2] / 4], [0, 0, 0]);
  const normal = cross(sub(p1, p0), sub(p3, p0));
  // Unit length, pointing away from the Earth's center.
  const length = Math.hypot(...normal) * Math.sign(dot(normal, center));
  const moved = points.map((p) =>
    fromEcef(
      [0, 1, 2].map((axis) => {
        const c = center[axis] ?? 0;
        return c + scale * ((p[axis] ?? 0) - c) - ((normal[axis] ?? 0) / length) * dropMeters;
      }) as Vec3,
    ),
  );
  return [moved[0] ?? corners[0], moved[1] ?? corners[1], moved[2] ?? corners[2], moved[3] ?? corners[3]];
}

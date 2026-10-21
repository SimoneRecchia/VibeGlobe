/**
 * Starting azimuth of the inverse geodesic problem (Karney 2013), in the canonical configuration of
 * {@link solveInverse}: β1 ≤ 0, |β2| ≤ |β1|, 0 ≤ λ12 ≤ π.
 */
import { DEG_TO_RAD } from './geodesic-angles.js';
import { GEOD_E2, GEOD_EP2, GEOD_F, createSeries, epsilonFromK2, updateSeries } from './geodesic-series.js';

/** How many astroid units (f π cos²β1) from the antipode the spherical estimate stays usable. */
const ANTIPODAL_ZONE = 6;
const MAX_ROOT_ITERATIONS = 100;
const startSeries = createSeries();

/**
 * The positive root μ of x² / (1 + μ)² + y² / μ² = 1 (the astroid of Karney 2013), for y ≠ 0. The left side decreases and
 * is convex in μ, and μ₀ = max(|y|, |x| - 1) lies left of the root, so Newton's method climbs to it monotonically.
 */
export function astroidRoot(x: number, y: number): number {
  const x2 = x * x;
  const y2 = y * y;
  let mu = Math.max(Math.abs(y), Math.abs(x) - 1);
  for (let i = 0; i < MAX_ROOT_ITERATIONS; i++) {
    const p = 1 + mu;
    const excess = x2 / (p * p) + y2 / (mu * mu) - 1;
    if (!(excess > 0)) break;
    const slope = (-2 * x2) / (p * p * p) - (2 * y2) / (mu * mu * mu);
    const next = mu - excess / slope;
    if (!(next > mu)) break;
    mu = next;
  }
  return mu;
}

/**
 * Starting azimuth for nearly antipodal points, written to `out` as (sin α1, cos α1) up to a positive factor. To first
 * order in f, a geodesic leaving β1 with azimuth α1 passes the antipode displaced by -f π cosβ1 sinα1 in longitude;
 * scaling the endpoint's offsets from the antipode by f π cosβ1 (longitude, x) and f π cos²β1 (latitude, y) puts the
 * solutions on Karney's astroid.
 */
function antipodalAzimuth(sb1: number, cb1: number, sbet12a: number, lon12Deg: number, out: Float64Array): void {
  updateSeries(startSeries, epsilonFromK2(GEOD_EP2 * sb1 * sb1));
  const lambdaScale = GEOD_F * cb1 * startSeries.a3 * Math.PI;
  const x = ((lon12Deg - 180) * DEG_TO_RAD) / lambdaScale;
  const y = sbet12a / (lambdaScale * cb1);
  if (y !== 0) {
    const mu = astroidRoot(x, y);
    out[0] = -x / (1 + mu);
    out[1] = y / mu;
  } else if (x > -1) {
    // Opposite latitudes and μ → 0: the solution lies on the circle x² + (y / μ)² = 1.
    out[0] = -x;
    out[1] = -Math.sqrt(Math.max(0, 1 - x * x));
  } else {
    // Opposite latitudes beyond the astroid's cusp: the geodesic runs between vertices.
    out[0] = 1;
    out[1] = 0;
  }
}

/**
 * Starting azimuth α1, written to `out` as the unit vector (sin α1, cos α1) with sin α1 > 0: the great-circle
 * solution on a sphere scaled by w̄ = √(1 - e² cos²β̄), or the astroid solution when the points are nearly
 * antipodal.
 */
export function initialAzimuth(
  sb1: number,
  cb1: number,
  sb2: number,
  cb2: number,
  lon12Deg: number,
  out: Float64Array,
): void {
  const sbet12 = sb2 * cb1 - cb2 * sb1;
  const sbet12a = sb2 * cb1 + cb2 * sb1;
  const meanCos = (cb1 + cb2) / 2;
  const omg12 = (lon12Deg * DEG_TO_RAD) / Math.sqrt(1 - GEOD_E2 * meanCos * meanCos);
  const somg12 = Math.sin(omg12);
  const comg12 = Math.cos(omg12);
  const salp = cb2 * somg12;
  const calp =
    comg12 >= 0
      ? sbet12 + (cb2 * sb1 * somg12 * somg12) / (1 + comg12)
      : sbet12a - (cb2 * sb1 * somg12 * somg12) / (1 - comg12);
  const ssig = Math.hypot(salp, calp);
  const csig = sb1 * sb2 + cb1 * cb2 * comg12;
  out[0] = salp;
  out[1] = calp;
  if (csig < 0 && ssig < ANTIPODAL_ZONE * GEOD_F * Math.PI * cb1 * cb1) {
    antipodalAzimuth(sb1, cb1, sbet12a, lon12Deg, out);
  }
  const norm = Math.hypot(out[0] ?? 0, out[1] ?? 0);
  out[0] = (out[0] ?? 0) / norm;
  out[1] = (out[1] ?? 0) / norm;
  if (!((out[0] ?? 0) > 0)) {
    out[0] = 1;
    out[1] = 0;
  }
}

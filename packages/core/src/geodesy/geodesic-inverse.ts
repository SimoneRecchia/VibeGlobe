// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * The inverse geodesic problem on the WGS84 ellipsoid — the shortest path between two points — after C. F. F. Karney,
 * "Algorithms for geodesics", J. Geodesy 87 (2013): the points are moved to a canonical configuration,
 * the azimuth α1 at the first point is found by safeguarded Newton iterations on the longitude λ12(α1), and the
 * distance and edge area follow from the series of `geodesic-series.ts`. Allocates nothing beyond its result.
 */
import { atan2Deg, longitudeDifferenceDeg, sinCosDeg, snapTinyDeg } from './geodesic-angles.js';
import {
  GEOD_A_METERS,
  GEOD_B_METERS,
  GEOD_C2_SQUARE_METERS,
  GEOD_E2,
  GEOD_EP2,
  GEOD_F,
  cosOddSeries,
  createSeries,
  epsilonFromK2,
  sinSeries,
  updateAreaSeries,
  updateSeries,
} from './geodesic-series.js';
import { initialAzimuth } from './geodesic-start.js';

/** Solution of the inverse geodesic problem. */
export interface GeodesicInverseResult {
  /** Length of the shortest geodesic between the two points, in meters. */
  distanceMeters: number;
  /** Azimuth of the geodesic at the first point, clockwise from north, in (-180, 180] degrees. */
  initialAzimuthDeg: number;
  /** Azimuth of the geodesic at the second point (direction of travel), clockwise from north, in (-180, 180]. */
  finalAzimuthDeg: number;
}

/** Index of the distance in meters in the output of {@link solveInverse}. */
export const OUT_DISTANCE = 0;
/** Index of the initial azimuth in degrees. */
export const OUT_AZIMUTH1 = 1;
/** Index of the final azimuth in degrees. */
export const OUT_AZIMUTH2 = 2;
/** Index of the edge area S12 in square meters: the area between the geodesic and the equator. */
export const OUT_AREA = 3;

const ONE_MINUS_F = 1 - GEOD_F;
const TINY = Math.sqrt(Number.MIN_VALUE * 2 ** 52);
const MAX_ITERATIONS = 100;
/** Residual of λ12, in radians, below which the Newton iteration has converged (four ulps of 1). */
const LAMBDA_TOLERANCE = 4 * Number.EPSILON;
const AREA_FACTOR = GEOD_E2 * GEOD_A_METERS * GEOD_A_METERS;

const series = createSeries();
const trig = new Float64Array(2);
const output = new Float64Array(4);

// State of the current solve, in the canonical configuration (β1 ≤ 0, |β2| ≤ |β1|, 0 ≤ λ12 ≤ π).
let sb1 = 0;
let cb1 = 1;
let sb2 = 0;
let cb2 = 1;
let slam12 = 0;
let clam12 = 1;
let salp1 = 0;
let calp1 = 1;
let salp2 = 0;
let calp2 = 1;
let salp0 = 0;
let calp0 = 1;
let ssig1 = 0;
let csig1 = 1;
let ssig2 = 0;
let csig2 = 1;
let sig12 = 0;
let lambdaCorrection = 0;
let k2 = 0;
let s12 = 0;
let m12 = 0;
let dLambdaDAlpha1 = 0;

/**
 * Writes sin and cos of the reduced latitude β of geodetic latitude `latDeg` to `trig`. cos β is kept above zero so
 * that azimuths at a pole are the limits found when approaching it along the point's meridian.
 */
function reducedLatitude(latDeg: number): void {
  sinCosDeg(Math.abs(latDeg), trig, 0);
  const sine = ONE_MINUS_F * (trig[0] ?? 0) * (latDeg < 0 ? -1 : 1);
  const cosine = trig[1] ?? 0;
  const norm = Math.hypot(sine, cosine);
  trig[0] = sine / norm;
  trig[1] = Math.max(TINY, cosine / norm);
}

/** Normalizes the auxiliary-sphere arcs σ1 and σ2 and sets σ12 in [0, π]. */
function setArcs(): void {
  let norm = Math.hypot(ssig1, csig1);
  ssig1 /= norm;
  csig1 /= norm;
  norm = Math.hypot(ssig2, csig2);
  ssig2 /= norm;
  csig2 /= norm;
  sig12 = Math.atan2(Math.max(0, csig1 * ssig2 - ssig1 * csig2), csig1 * csig2 + ssig1 * ssig2);
}

/** Distance s12 and reduced length m12 of the current geodesic, from the current series. */
function lengths(): void {
  const b1 = sinSeries(series.c1, ssig2, csig2) - sinSeries(series.c1, ssig1, csig1);
  const b2 = sinSeries(series.c2, ssig2, csig2) - sinSeries(series.c2, ssig1, csig1);
  const j12 = (series.a1 - series.a2) * sig12 + (series.a1 * b1 - series.a2 * b2);
  const w1 = Math.sqrt(1 + k2 * ssig1 * ssig1);
  const w2 = Math.sqrt(1 + k2 * ssig2 * ssig2);
  s12 = GEOD_B_METERS * series.a1 * (sig12 + b1);
  m12 = GEOD_B_METERS * (w2 * csig1 * ssig2 - w1 * ssig1 * csig2 - csig1 * csig2 * j12);
}

/** cos²β2 - cos²β1, evaluated in the better-conditioned of its two forms. */
function cosSquaredDifference(): number {
  return cb1 < -sb1 ? (cb2 - cb1) * (cb2 + cb1) : (sb1 - sb2) * (sb1 + sb2);
}

/**
 * Follows the geodesic leaving point 1 with the azimuth α1 held in (salp1, calp1) to the latitude of point 2 and
 * returns λ12(α1) minus the target λ12, leaving the geodesic and dλ12/dα1 = m12 / (a cosα2 cosβ2) (or its limit
 * 2 (1 - f) √(1 + e'² sin²β1) / |sin β1| for cosα2 = 0, between vertices) in the state.
 */
function lambdaResidual(): number {
  salp0 = salp1 * cb1;
  calp0 = Math.hypot(calp1, salp1 * sb1);
  salp2 = cb2 !== cb1 ? salp0 / cb2 : salp1;
  calp2 =
    cb2 !== cb1 || Math.abs(sb2) !== -sb1
      ? Math.sqrt(Math.max(0, calp1 * cb1 * (calp1 * cb1) + cosSquaredDifference())) / cb2
      : Math.abs(calp1);
  ssig1 = sb1;
  csig1 = calp1 * cb1;
  ssig2 = sb2;
  csig2 = calp2 * cb2;
  setArcs();
  // ω on the auxiliary sphere: tan ω = sinα₀ tan σ; the pairs need no normalization for a difference angle.
  const somg1 = salp0 * sb1;
  const comg1 = calp1 * cb1;
  const somg2 = salp0 * sb2;
  const comg2 = calp2 * cb2;
  const somg12 = Math.max(0, comg1 * somg2 - somg1 * comg2);
  const comg12 = comg1 * comg2 + somg1 * somg2;
  const eta = Math.atan2(somg12 * clam12 - comg12 * slam12, comg12 * clam12 + somg12 * slam12);
  k2 = calp0 * calp0 * GEOD_EP2;
  updateSeries(series, epsilonFromK2(k2));
  const b3 = sinSeries(series.d3, ssig2, csig2) - sinSeries(series.d3, ssig1, csig1);
  lengths();
  dLambdaDAlpha1 =
    calp2 === 0 ? (-2 * ONE_MINUS_F * Math.sqrt(1 + GEOD_EP2 * sb1 * sb1)) / sb1 : m12 / (GEOD_A_METERS * calp2 * cb2);
  lambdaCorrection = GEOD_F * salp0 * (series.a3 * sig12 + b3);
  return eta - lambdaCorrection;
}

/**
 * Finds α1 with λ12(α1) = λ12 by Newton's method from the start in (salp1, calp1), falling back to bisection of a
 * bracket that starts as [0, π]. α1 is kept as the unit vector (sin α1, cos α1), never as an angle, so that azimuths
 * near 90° (nearly equatorial geodesics) keep the full relative precision of cos α1.
 */
function solveAlpha1(): void {
  let lowS = 0;
  let lowC = 1;
  let highS = 0;
  let highC = -1;
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const residual = lambdaResidual();
    if (!(Math.abs(residual) > LAMBDA_TOLERANCE)) return;
    if (residual > 0) {
      highS = salp1;
      highC = calp1;
    } else {
      lowS = salp1;
      lowC = calp1;
    }
    const step = -residual / dLambdaDAlpha1;
    let s = salp1 * Math.cos(step) + calp1 * Math.sin(step);
    let c = calp1 * Math.cos(step) - salp1 * Math.sin(step);
    const inside = s > 0 && c * lowS < lowC * s && c * highS > highC * s;
    if (!(dLambdaDAlpha1 > 0 && Math.abs(step) < Math.PI && inside)) {
      s = lowS + highS;
      c = lowC + highC;
      if (s === 0) {
        s = 1;
        c = 0;
      }
    }
    const norm = Math.hypot(s, c);
    if (s / norm === salp1 && c / norm === calp1) return;
    salp1 = s / norm;
    calp1 = c / norm;
  }
}

/** Tries the meridian through both points (λ12 = 0 or π, or point 1 at a pole); false when it is not shortest. */
function meridional(): boolean {
  salp1 = slam12;
  calp1 = clam12;
  salp2 = 0;
  calp2 = 1;
  salp0 = salp1 * cb1;
  calp0 = Math.hypot(calp1, salp1 * sb1);
  lambdaCorrection = 0;
  ssig1 = sb1;
  csig1 = calp1 * cb1;
  ssig2 = sb2;
  csig2 = calp2 * cb2;
  setArcs();
  k2 = calp0 * calp0 * GEOD_EP2;
  updateSeries(series, epsilonFromK2(k2));
  lengths();
  // Past the conjugate point (m12 < 0) the meridian is no longer the shortest path.
  return sig12 < 1 || m12 >= 0;
}

/** The geodesic along the equator, shortest while λ12 ≤ (1 - f) π. */
function equatorial(lam12: number): void {
  salp1 = 1;
  calp1 = 0;
  salp2 = 1;
  calp2 = 0;
  salp0 = 1;
  calp0 = 0;
  lambdaCorrection = 0;
  s12 = GEOD_A_METERS * lam12;
}

/** Solves the canonical problem: β1 ≤ 0, |β2| ≤ |β1|, 0 ≤ λ12 ≤ 180°. */
function solveCanonical(latADeg: number, latBDeg: number, lon12Deg: number): void {
  reducedLatitude(latADeg);
  sb1 = trig[0] ?? 0;
  cb1 = trig[1] ?? 1;
  reducedLatitude(latBDeg);
  sb2 = trig[0] ?? 0;
  cb2 = trig[1] ?? 1;
  // Rounding may break |β2| <= |β1| for latitudes a few ulps apart, in the form cosSquaredDifference() relies on;
  // such points are treated as equally far from the equator, a change of one ulp.
  if (cb1 < -sb1 ? cb2 < cb1 : Math.abs(sb2) > -sb1) {
    sb2 = sb2 < 0 ? sb1 : -sb1;
    cb2 = cb1;
  }
  sinCosDeg(lon12Deg, trig, 0);
  slam12 = trig[0] ?? 0;
  clam12 = trig[1] ?? 1;
  if ((latADeg === -90 || slam12 === 0) && meridional()) return;
  if (sb1 === 0 && lon12Deg <= 180 * ONE_MINUS_F) {
    equatorial((lon12Deg * Math.PI) / 180);
    return;
  }
  initialAzimuth(sb1, cb1, sb2, cb2, lon12Deg, trig);
  salp1 = trig[0] ?? 1;
  calp1 = trig[1] ?? 0;
  solveAlpha1();
}

/** α2 - α1 of the canonical geodesic; both azimuths lie in [0, π], so it is ±π only for a meridian over the pole. */
function azimuthChange(): number {
  const salp12 = salp2 * calp1 - calp2 * salp1;
  const calp12 = calp2 * calp1 + salp2 * salp1;
  return salp12 === 0 && calp12 < 0 ? -Math.PI : Math.atan2(salp12, calp12);
}

/**
 * α2 - α1 free of cancellation for short lines: it is the spherical excess of the quadrilateral formed with the
 * equator on the auxiliary sphere, tan((α2 - α1) / 2) = tan(ω12 / 2) sin((β1 + β2) / 2) / cos((β2 - β1) / 2), with
 * ω12 = λ12 + f sinα₀ I3 taken from the exact λ12 rather than from the iteration. Returns NaN where the formula is
 * ill-conditioned (ω12 or β2 - β1 beyond 90°).
 */
function shortAzimuthChange(): number {
  const cosCorrection = Math.cos(lambdaCorrection);
  const sinCorrection = Math.sin(lambdaCorrection);
  const somg12 = slam12 * cosCorrection + clam12 * sinCorrection;
  const comg12 = clam12 * cosCorrection - slam12 * sinCorrection;
  const cbet12 = sb1 * sb2 + cb1 * cb2;
  if (!(comg12 > 0 && cbet12 > 0)) return NaN;
  return 2 * Math.atan2(somg12 * (sb1 + sb2), (1 + comg12) * (1 + cbet12));
}

/** Edge area S12 of the canonical geodesic: c² (α2 - α1) + e² a² cosα₀ sinα₀ (I4(σ2) - I4(σ1)). */
function canonicalEdgeArea(): number {
  let alp12 = shortAzimuthChange();
  if (Number.isNaN(alp12)) alp12 = azimuthChange();
  if (salp0 === 0 || calp0 === 0) return GEOD_C2_SQUARE_METERS * alp12;
  updateAreaSeries(series, k2);
  const i4Difference = cosOddSeries(series.c4, ssig2, csig2) - cosOddSeries(series.c4, ssig1, csig1);
  return GEOD_C2_SQUARE_METERS * alp12 + AREA_FACTOR * calp0 * salp0 * i4Difference;
}

/** Undoes the canonical transformations on the azimuths: equator reflection, meridian reflection, endpoint swap. */
function restoreAzimuths(latSign: number, lonSign: number, swap: number): void {
  calp1 *= latSign;
  calp2 *= latSign;
  salp1 *= lonSign;
  salp2 *= lonSign;
  if (swap < 0) {
    const s = salp1;
    const c = calp1;
    salp1 = -salp2;
    calp1 = -calp2;
    salp2 = -s;
    calp2 = -c;
  }
}

/**
 * Solves the inverse problem into a shared scratch array (indices `OUT_*`): distance in meters, azimuths in degrees
 * and, when `withArea`, the edge area S12 in square meters (NaN otherwise). The array is overwritten by the next call.
 */
export function solveInverse(
  lon1Deg: number,
  lat1Deg: number,
  lon2Deg: number,
  lat2Deg: number,
  withArea: boolean,
): Float64Array {
  if (!(Math.abs(lat1Deg) <= 90 && Math.abs(lat2Deg) <= 90)) return output.fill(NaN);
  // Canonical configuration: swap the points so that |latA| >= |latB|, then reflect so that lonB - lonA >= 0 and
  // latA <= 0.
  const lat1 = snapTinyDeg(lat1Deg);
  const lat2 = snapTinyDeg(lat2Deg);
  const swap = Math.abs(lat1) < Math.abs(lat2) ? -1 : 1;
  const lon12Deg = snapTinyDeg(
    swap > 0 ? longitudeDifferenceDeg(lon1Deg, lon2Deg) : longitudeDifferenceDeg(lon2Deg, lon1Deg),
  );
  if (!Number.isFinite(lon12Deg)) return output.fill(NaN);
  const latADeg = swap > 0 ? lat1 : lat2;
  const latBDeg = swap > 0 ? lat2 : lat1;
  const lonSign = lon12Deg < 0 ? -1 : 1;
  // Points on the equator are reflected too, so that the solutions north of the equator win ties.
  const latSign = latADeg >= 0 ? -1 : 1;
  solveCanonical(latADeg * latSign, latBDeg * latSign, lon12Deg * lonSign);
  output[OUT_AREA] = withArea ? canonicalEdgeArea() * latSign * swap * lonSign : NaN;
  restoreAzimuths(latSign, lonSign, swap);
  output[OUT_DISTANCE] = s12;
  output[OUT_AZIMUTH1] = atan2Deg(salp1, calp1);
  output[OUT_AZIMUTH2] = atan2Deg(salp2, calp2);
  return output;
}

/**
 * Solves the inverse geodesic problem on the WGS84 ellipsoid: the length of the shortest path between two points and
 * its azimuths at both ends (Karney's algorithm; distances accurate to well below a micrometer). Returns NaN fields
 * for latitudes outside [-90, 90] or non-finite input. Azimuths at a pole follow the convention that the pole is
 * approached along the given longitude's meridian.
 *
 * @param lon1Deg - Longitude of the first point, in degrees.
 * @param lat1Deg - Latitude of the first point, in degrees.
 * @param lon2Deg - Longitude of the second point, in degrees.
 * @param lat2Deg - Latitude of the second point, in degrees.
 */
export function geodesicInverse(
  lon1Deg: number,
  lat1Deg: number,
  lon2Deg: number,
  lat2Deg: number,
): GeodesicInverseResult {
  const result = solveInverse(lon1Deg, lat1Deg, lon2Deg, lat2Deg, false);
  return {
    distanceMeters: result[OUT_DISTANCE] ?? NaN,
    initialAzimuthDeg: result[OUT_AZIMUTH1] ?? NaN,
    finalAzimuthDeg: result[OUT_AZIMUTH2] ?? NaN,
  };
}

/**
 * The direct geodesic problem on the WGS84 ellipsoid — where a geodesic of given start, azimuth and length ends — after
 * C. F. F. Karney, "Algorithms for geodesics", J. Geodesy 87 (2013): the distance is mapped to an arc on
 * the auxiliary sphere by inverting s = b I1(σ) with Newton's method, then to the end point and longitude.
 */
import { RAD_TO_DEG, atan2Deg, normalizeDeg, sinCosDeg, snapTinyDeg } from './geodesic-angles.js';
import {
  GEOD_B_METERS,
  GEOD_EP2,
  GEOD_F,
  createSeries,
  epsilonFromK2,
  sinSeries,
  updateSeries,
} from './geodesic-series.js';

/** Solution of the direct geodesic problem. */
export interface GeodesicDirectResult {
  /** Longitude of the end point, in (-180, 180] degrees. */
  longitudeDeg: number;
  /** Latitude of the end point, in degrees. */
  latitudeDeg: number;
  /** Azimuth of the geodesic at the end point (direction of travel), clockwise from north, in (-180, 180]. */
  finalAzimuthDeg: number;
}

const ONE_MINUS_F = 1 - GEOD_F;
const TINY = Math.sqrt(Number.MIN_VALUE * 2 ** 52);
const MAX_ARC_ITERATIONS = 10;
const series = createSeries();
const trig = new Float64Array(2);

/**
 * Solves σ12 + B1(σ1 + σ12) - B1(σ1) = τ12 for the arc σ12 on the auxiliary sphere (I1 = A1 (σ + B1(σ))), by Newton's
 * method from σ12 = τ12; dτ/dσ = √(1 + k² sin²σ) / A1. Leaves sin and cos of σ2 in `trig` and returns σ12.
 */
function arcFromDistance(tau12: number, ssig1: number, csig1: number, k2: number): number {
  const b11 = sinSeries(series.c1, ssig1, csig1);
  let sig12 = tau12;
  for (let i = 0; i < MAX_ARC_ITERATIONS; i++) {
    const ssig12 = Math.sin(sig12);
    const csig12 = Math.cos(sig12);
    const ssig2 = ssig1 * csig12 + csig1 * ssig12;
    const csig2 = csig1 * csig12 - ssig1 * ssig12;
    trig[0] = ssig2;
    trig[1] = csig2;
    const excess = sig12 + sinSeries(series.c1, ssig2, csig2) - b11 - tau12;
    const delta = (excess * series.a1) / Math.sqrt(1 + k2 * ssig2 * ssig2);
    if (!(Math.abs(delta) > Number.EPSILON * Math.max(1, Math.abs(sig12)))) break;
    sig12 -= delta;
  }
  return sig12;
}

/**
 * Solves the direct geodesic problem on the WGS84 ellipsoid: the end point and final azimuth of the geodesic that
 * leaves a point with a given azimuth and runs for a given distance (negative distances run backwards). Returns NaN
 * fields for a latitude outside [-90, 90] or non-finite input.
 *
 * @param lonDeg - Longitude of the start point, in degrees.
 * @param latDeg - Latitude of the start point, in degrees.
 * @param azimuthDeg - Azimuth at the start point, clockwise from north, in degrees.
 * @param distanceMeters - Length of the geodesic, in meters.
 */
export function geodesicDirect(
  lonDeg: number,
  latDeg: number,
  azimuthDeg: number,
  distanceMeters: number,
): GeodesicDirectResult {
  if (!(Math.abs(latDeg) <= 90 && Number.isFinite(lonDeg + azimuthDeg + distanceMeters))) {
    return { longitudeDeg: NaN, latitudeDeg: NaN, finalAzimuthDeg: NaN };
  }
  sinCosDeg(snapTinyDeg(azimuthDeg), trig, 0);
  const salp1 = trig[0] ?? 0;
  const calp1 = trig[1] ?? 1;
  sinCosDeg(Math.abs(snapTinyDeg(latDeg)), trig, 0);
  const sphi = (trig[0] ?? 0) * (latDeg < 0 ? -1 : 1);
  const betaNorm = Math.hypot(ONE_MINUS_F * sphi, trig[1] ?? 0);
  const sb1 = (ONE_MINUS_F * sphi) / betaNorm;
  const cb1 = Math.max(TINY, (trig[1] ?? 0) / betaNorm);
  const salp0 = salp1 * cb1;
  const calp0 = Math.hypot(calp1, salp1 * sb1);
  // σ1 and ω1 from tan σ1 = tan β1 / cos α1 and tan ω1 = sin α₀ tan σ1; σ1 = 0 when leaving the equator eastwards.
  const csig1Raw = sb1 !== 0 || calp1 !== 0 ? calp1 * cb1 : 1;
  const sigNorm = Math.hypot(sb1, csig1Raw);
  const ssig1 = sb1 / sigNorm;
  const csig1 = csig1Raw / sigNorm;
  const k2 = calp0 * calp0 * GEOD_EP2;
  updateSeries(series, epsilonFromK2(k2));
  const sig12 = arcFromDistance(distanceMeters / (GEOD_B_METERS * series.a1), ssig1, csig1, k2);
  const ssig2 = trig[0] ?? 0;
  const csig2 = trig[1] ?? 1;
  const sb2 = calp0 * ssig2;
  const cb2 = Math.hypot(salp0, calp0 * csig2);
  const somg1 = salp0 * ssig1;
  const somg2 = salp0 * ssig2;
  const omg12 = Math.atan2(somg2 * csig1 - csig2 * somg1, csig2 * csig1 + somg2 * somg1);
  const b3 = sinSeries(series.d3, ssig2, csig2) - sinSeries(series.d3, ssig1, csig1);
  const lam12 = omg12 - GEOD_F * salp0 * (series.a3 * sig12 + b3);
  return {
    longitudeDeg: normalizeDeg(normalizeDeg(lonDeg) + lam12 * RAD_TO_DEG),
    latitudeDeg: atan2Deg(sb2, ONE_MINUS_F * cb2),
    finalAzimuthDeg: atan2Deg(salp0, calp0 * csig2),
  };
}

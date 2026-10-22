import type { Camera } from '../camera/camera.js';
import type { GeodeticRad } from '../geodesy/ecef.js';
import { inverseCappedMercatorInto, MorphFrame, morphPointInto } from './morph.js';

const direction = new Float64Array(3);
const point = new Float64Array(3);
const shifted = new Float64Array(3);
const geodetic = new Float64Array(3);
const jacobian = new Float64Array(6);
const residual = new Float64Array(3);
const planeXy = new Float64Array(2);
const lonLat = new Float64Array(2);
const ellipsoidHit: GeodeticRad = { longitudeRad: 0, latitudeRad: 0, heightMeters: 0 };

/** Newton steps at most, and the finite-difference step in radians (about 6 mm on the ground). */
const MAX_STEPS = 8;
const STEP_RAD = 1e-9;
/** A solve has converged when the point lies within this distance of the ray, meters. */
const TOLERANCE_METERS = 1e-4;

/**
 * Intersects the ray through a CSS pixel (`pixel[0..1]`) with the anchor's tangent plane; writes the longitude and
 * latitude of the hit (radians) to `lonLat` and returns true, or false when the ray points away from the plane.
 */
function pickPlane(camera: Camera, frame: MorphFrame, out: Float64Array): boolean {
  const eye = camera.eyeEcef;
  const axes = frame.axes;
  let towards = 0;
  let along = 0;
  for (let i = 0; i < 3; i++) {
    towards += ((frame.anchorEcef[i] ?? 0) - (eye[i] ?? 0)) * (axes[6 + i] ?? 0);
    along += (direction[i] ?? 0) * (axes[6 + i] ?? 0);
  }
  if (along === 0) return false;
  const t = towards / along;
  if (!(t > 0)) return false;
  let east = 0;
  let north = 0;
  for (let i = 0; i < 3; i++) {
    const offset = (eye[i] ?? 0) + t * (direction[i] ?? 0) - (frame.anchorEcef[i] ?? 0);
    east += offset * (axes[i] ?? 0);
    north += offset * (axes[3 + i] ?? 0);
  }
  planeXy[0] = (frame.anchorMercator[0] ?? 0) + east / (frame.factors[2] ?? 1);
  planeXy[1] = (frame.anchorMercator[1] ?? 0) + north / (frame.factors[2] ?? 1);
  inverseCappedMercatorInto(planeXy, out);
  return true;
}

/** The part of `morphed − eye` perpendicular to the ray, into `out`. */
function perpendicularInto(morphed: Float64Array, eye: Float64Array, out: Float64Array): void {
  let along = 0;
  for (let i = 0; i < 3; i++) along += ((morphed[i] ?? 0) - (eye[i] ?? 0)) * (direction[i] ?? 0);
  for (let i = 0; i < 3; i++) out[i] = (morphed[i] ?? 0) - (eye[i] ?? 0) - along * (direction[i] ?? 0);
}

/**
 * The surface point under a CSS pixel (`pixel[0..1]`) as the frame draws it (ADR 0008: one morph function everywhere):
 * the ellipsoid at m = 0, the anchor's tangent plane at m = 1, and between them the point whose morphed position lies
 * on the pixel's ray, found by a float64 Newton solve started from the nearer endpoint's hit. Writes the geodetic
 * position (height 0: the surface without relief) to `out` and returns true, or false when the ray misses the surface.
 * Allocates nothing.
 */
export function pickMorphedAt(camera: Camera, frame: MorphFrame, pixel: Float64Array, out: GeodeticRad): boolean {
  const m = frame.factors[0] ?? 0;
  if (m === 0) return camera.pickEllipsoidAt(pixel, out);
  camera.rayDirectionAt(pixel, direction);
  if (m === 1) {
    if (!pickPlane(camera, frame, lonLat)) return false;
    out.longitudeRad = lonLat[0] ?? 0;
    out.latitudeRad = lonLat[1] ?? 0;
    out.heightMeters = 0;
    return true;
  }
  // Newton starts from the ellipsoid's hit, or from the plane's where the ray misses the ellipsoid.
  if (camera.pickEllipsoidAt(pixel, ellipsoidHit)) {
    geodetic[0] = ellipsoidHit.longitudeRad;
    geodetic[1] = ellipsoidHit.latitudeRad;
  } else if (pickPlane(camera, frame, lonLat)) {
    geodetic[0] = lonLat[0] ?? 0;
    geodetic[1] = lonLat[1] ?? 0;
  } else return false;
  geodetic[2] = 0;
  return solveOnRay(frame, camera.eyeEcef, out);
}

/**
 * Newton's method from the guess in `geodetic` (ADR 0008): moves the longitude and latitude until the morphed point
 * lies on the ray from `eye` along `direction`; writes it to `out` and returns true, or false when it does not converge.
 */
function solveOnRay(frame: MorphFrame, eye: Float64Array, out: GeodeticRad): boolean {
  for (let step = 0; step < MAX_STEPS; step++) {
    morphPointInto(frame, geodetic, point);
    perpendicularInto(point, eye, residual);
    const error = Math.sqrt((residual[0] ?? 0) ** 2 + (residual[1] ?? 0) ** 2 + (residual[2] ?? 0) ** 2);
    if (error < TOLERANCE_METERS) {
      out.longitudeRad = geodetic[0] ?? 0;
      out.latitudeRad = geodetic[1] ?? 0;
      out.heightMeters = 0;
      return true;
    }
    // The 3 × 2 Jacobian of the perpendicular part, by forward differences in longitude and latitude.
    for (let column = 0; column < 2; column++) {
      geodetic[column] = (geodetic[column] ?? 0) + STEP_RAD;
      morphPointInto(frame, geodetic, shifted);
      geodetic[column] = (geodetic[column] ?? 0) - STEP_RAD;
      perpendicularInto(shifted, eye, shifted);
      for (let i = 0; i < 3; i++) jacobian[column * 3 + i] = ((shifted[i] ?? 0) - (residual[i] ?? 0)) / STEP_RAD;
    }
    // Least squares: (JᵀJ)·δ = −Jᵀ·e.
    let a = 0;
    let b = 0;
    let c = 0;
    let p = 0;
    let q = 0;
    for (let i = 0; i < 3; i++) {
      const j0 = jacobian[i] ?? 0;
      const j1 = jacobian[3 + i] ?? 0;
      const e = residual[i] ?? 0;
      a += j0 * j0;
      b += j0 * j1;
      c += j1 * j1;
      p -= j0 * e;
      q -= j1 * e;
    }
    const determinant = a * c - b * b;
    if (determinant === 0) return false;
    geodetic[0] = (geodetic[0] ?? 0) + (c * p - b * q) / determinant;
    geodetic[1] = (geodetic[1] ?? 0) + (a * q - b * p) / determinant;
    const lat: number = geodetic[1] ?? 0;
    geodetic[1] = lat > Math.PI / 2 ? Math.PI / 2 : lat < -Math.PI / 2 ? -Math.PI / 2 : lat;
  }
  return false;
}

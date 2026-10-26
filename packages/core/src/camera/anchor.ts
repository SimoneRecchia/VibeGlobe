// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { ecefArrayToGeodetic, geodeticArrayToEcef } from '../geodesy/ecef.js';
import { enuFrameAtArray } from '../geodesy/enu.js';
import { wrapLongitudeRad } from '../projections/longitude.js';
import type { Camera } from './camera.js';
import { projectToScreen } from './projection.js';
import { morphPointInto, type MorphFrame } from '../view/morph.js';

const MAX_ITERATIONS = 8;
/** Iterations stop below this residual. */
const TOLERANCE_PX = 0.001;
/** A solve succeeds only within this residual (ADR 0009: anchor drift at most 0.01 px). */
const ACCEPT_PX = 0.01;
const RIGID_ITERATIONS = 6;
/**
 * Rigid rotations stop below this residual: each is exact on a sphere and converges on the ellipsoid, a few more
 * steps leaving a 'free' drag (which uses them first) as exact as Gauss–Newton.
 */
const RIGID_TOLERANCE_PX = 1e-5;

/** {@link solveAnchor}'s modes: heading held, rotating rigidly only where that fails (zooms, KB-094). */
export const ANCHOR_HOLD_HEADING = 0;
/** A 'free' drag: on the globe the camera rotates rigidly about the Earth's center, turning the heading (trackball). */
export const ANCHOR_TRACKBALL = 1;
/** A 'north-up' drag or zoom: the heading never changes, and the target stops at {@link NORTH_UP_LIMIT_RAD}. */
export const ANCHOR_NORTH_UP = 2;
/** How close to a pole a 'north-up' target goes, radians (89.9°): there the heading-held drag stops. */
export const NORTH_UP_LIMIT_RAD = (89.9 * Math.PI) / 180;
/** The target latitude Gauss–Newton may reach otherwise, radians: just short of a pole. */
const POLE_LIMIT_RAD = Math.PI / 2 - 1e-9;
/** True while a 'north-up' solve runs: Gauss–Newton then stops at {@link NORTH_UP_LIMIT_RAD}. */
let northUpSolve = false;
/** Set when Gauss–Newton stopped because its target passed its latitude limit. */
let passedLimit = false;

const anchorEcef = new Float64Array(3);
/** The pixel the anchor must reach, CSS pixels. */
const targetPx = new Float64Array(2);
const screen = new Float64Array(2);

/** The anchor's geodetic position, and the frame's morph while the solve runs (ADR 0008). */
const anchorGeodetic = new Float64Array(3);
const morphAnchor = new Float64Array(2);
let solveMorph: MorphFrame | undefined;

/**
 * Screen residual of the anchor for the camera's current pose; false when it is behind the eye. Under a morph the
 * anchor shows where the morph anchored at the camera's target puts it, so each trial target moves it too.
 */
function residual(camera: Camera, out: Float64Array): boolean {
  camera.update();
  if (solveMorph && (solveMorph.factors[0] ?? 0) > 0) {
    morphAnchor[0] = camera.pose.targetLongitudeRad;
    morphAnchor[1] = camera.pose.targetLatitudeRad;
    solveMorph.update(morphAnchor, solveMorph.factors);
    morphPointInto(solveMorph, anchorGeodetic, anchorEcef);
  }
  if (!projectToScreen(camera, anchorEcef, screen)) return false;
  out[0] = (screen[0] ?? 0) - (targetPx[0] ?? 0);
  out[1] = (screen[1] ?? 0) - (targetPx[1] ?? 0);
  return true;
}

/** True when the 2-vector is shorter than `limit` (compared squared: no Math.hypot, whose arguments V8 boxes). */
function shorterThan(v: Float64Array, limit: number): boolean {
  return (v[0] ?? 0) * (v[0] ?? 0) + (v[1] ?? 0) * (v[1] ?? 0) < limit * limit;
}

const r0 = new Float64Array(2);
const rLon = new Float64Array(2);
const rLat = new Float64Array(2);
const start = new Float64Array(2);

/**
 * Moves the camera target so the geodetic anchor (`anchor[0..2]`: longitude and latitude in radians, height in meters)
 * appears at the pixel `pixel[0..1]`, holding range, heading and tilt (ADR 0009 anchor solver): Gauss–Newton on the
 * target longitude and latitude with a finite-difference Jacobian. When it cannot converge (the heading-held system is
 * singular near the poles) it falls back to rotating the whole camera rigidly about the Earth's center, which changes
 * the heading; a `guess` is tried first, a second start for Gauss–Newton. Returns false only if none reaches the pixel. Inputs come in arrays: the solver runs every frame of
 * a drag and V8 boxes doubles passed as arguments (ADR 0018). With a `morph`, the anchor is placed on the morphed
 * surface for each trial target (ADR 0008), and the morph is left anchored at the solved target.
 */
export function solveAnchor(
  camera: Camera,
  anchor: Float64Array,
  pixel: Float64Array,
  morph?: MorphFrame,
  guess?: Float64Array,
  mode: number = ANCHOR_HOLD_HEADING,
): boolean {
  geodeticArrayToEcef(anchor, anchorEcef);
  anchorGeodetic[0] = anchor[0] ?? 0;
  anchorGeodetic[1] = anchor[1] ?? 0;
  anchorGeodetic[2] = anchor[2] ?? 0;
  solveMorph = morph;
  targetPx[0] = pixel[0] ?? 0;
  targetPx[1] = pixel[1] ?? 0;
  const pose = camera.pose;
  start[0] = pose.targetLongitudeRad;
  start[1] = pose.targetLatitudeRad;
  // A 'free' drag on the globe rotates rigidly first (a trackball); on the flattening or flat map it holds the heading.
  if (mode === ANCHOR_TRACKBALL && !(solveMorph && (solveMorph.factors[0] ?? 0) > 0)) {
    if (rotateToPixel(camera)) return true;
    restoreStart(camera);
    return gaussNewton(camera);
  }
  // 'North-up' never rotates rigidly, which would turn the heading: past its limit the target stops there.
  const northUp = mode === ANCHOR_NORTH_UP;
  northUpSolve = northUp;
  passedLimit = false;
  return (
    gaussNewton(camera) ||
    (guess !== undefined && retryFrom(camera, guess)) ||
    (northUp ? passedLimit && holdAtLimit(camera) : rotateToPixel(camera))
  );
}

/** Puts the target back where the solve started. */
function restoreStart(camera: Camera): void {
  camera.pose.targetLongitudeRad = start[0] ?? 0;
  camera.pose.targetLatitudeRad = start[1] ?? 0;
}

/**
 * The target stopped at the north-up limit nearest the pole the solve headed for, with the longitude of its last step:
 * the camera halts at the pole while the cursor goes on. True when the anchor is still in front of the eye.
 */
function holdAtLimit(camera: Camera): boolean {
  // Past the limit, the target's latitude is nonzero.
  camera.pose.targetLatitudeRad = Math.sign(camera.pose.targetLatitudeRad) * NORTH_UP_LIMIT_RAD;
  return residual(camera, r0);
}

/**
 * Gauss–Newton again from a second start (`guess[0..1]`: target longitude and latitude, radians), such as a zoom's
 * target scaled toward the point: a large step can leave the anchor behind the eye from the first (KB-094). Kept out
 * of {@link solveAnchor} as a cold path (KB-033).
 */
function retryFrom(camera: Camera, guess: Float64Array): boolean {
  camera.pose.targetLongitudeRad = guess[0] ?? 0;
  camera.pose.targetLatitudeRad = guess[1] ?? 0;
  return gaussNewton(camera);
}

/**
 * The fallback of {@link solveAnchor}, kept out of it: V8 tiers a function up after executing about as much bytecode as
 * it has, so a cold path inside the hot function would keep it interpreted, boxing every double, for thousands of calls
 * where the optimizing compiler would not have finished warming up (KB-033).
 */
function rotateToPixel(camera: Camera): boolean {
  restoreStart(camera);
  // Each rotation is exact for a sphere; on the ellipsoid a few converge to the pixel.
  for (let i = 0; i < RIGID_ITERATIONS; i++) {
    if (!rotateRigidly(camera)) return false;
    if (shorterThan(r0, RIGID_TOLERANCE_PX)) return true;
  }
  return shorterThan(r0, ACCEPT_PX);
}

function gaussNewton(camera: Camera): boolean {
  const pose = camera.pose;
  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    if (!residual(camera, r0)) return false;
    if (shorterThan(r0, TOLERANCE_PX)) return true;
    const scaledStep = (1e-6 * pose.rangeMeters) / 6.4e6;
    const step = scaledStep > 1e-12 ? scaledStep : 1e-12;
    const lon = pose.targetLongitudeRad;
    const lat = pose.targetLatitudeRad;
    pose.targetLongitudeRad = lon + step;
    const okLon = residual(camera, rLon);
    pose.targetLongitudeRad = lon;
    pose.targetLatitudeRad = lat + step;
    const okLat = residual(camera, rLat);
    pose.targetLatitudeRad = lat;
    if (!okLon || !okLat) return false;
    const j00 = ((rLon[0] ?? 0) - (r0[0] ?? 0)) / step;
    const j10 = ((rLon[1] ?? 0) - (r0[1] ?? 0)) / step;
    const j01 = ((rLat[0] ?? 0) - (r0[0] ?? 0)) / step;
    const j11 = ((rLat[1] ?? 0) - (r0[1] ?? 0)) / step;
    const determinant = j00 * j11 - j01 * j10;
    // determinant − determinant is NaN unless it is finite; Number.isFinite would be a call with a boxed argument.
    if (!(determinant - determinant === 0) || (determinant < 1e-30 && determinant > -1e-30)) return false;
    const dLon = (j11 * (r0[0] ?? 0) - j01 * (r0[1] ?? 0)) / determinant;
    const dLat = (-j10 * (r0[0] ?? 0) + j00 * (r0[1] ?? 0)) / determinant;
    const nextLon = lon - dLon;
    // Wrapping is a call with a double argument: only when the step leaves [-π, π).
    pose.targetLongitudeRad = nextLon >= -Math.PI && nextLon < Math.PI ? nextLon : wrapLongitudeRad(nextLon);
    pose.targetLatitudeRad = lat - dLat;
    const limit = northUpSolve ? NORTH_UP_LIMIT_RAD : POLE_LIMIT_RAD;
    if (pose.targetLatitudeRad > limit || pose.targetLatitudeRad < -limit) {
      passedLimit = true;
      return false;
    }
  }
  if (!residual(camera, r0)) return false;
  return shorterThan(r0, ACCEPT_PX);
}

const ray = new Float64Array(3);
const hit = new Float64Array(3);
const rotation = new Float64Array(9);
const enu = new Float64Array(9);
const vector = new Float64Array(3);
/** The sphere test's radius in, the distance along the ray out ({@link sphereHit}). */
const sphere = new Float64Array(2);
const rotatedTarget = { longitudeRad: 0, latitudeRad: 0, heightMeters: 0 };
/** A target's longitude and latitude for {@link enuFrameAtArray}. */
const position = new Float64Array(2);

/**
 * Rotates the camera about the Earth's center so the anchor moves under the pixel and updates the heading to match;
 * leaves the residual in `r0`. Returns false when the pixel's ray misses the anchor's sphere or the anchor goes behind
 * the eye. The main path of a 'free' drag, so it allocates nothing: doubles stay in arrays (ADR 0018).
 */
function rotateRigidly(camera: Camera): boolean {
  camera.update();
  camera.rayDirectionAt(targetPx, ray);
  const eye = camera.eyeEcef;
  const ax = anchorEcef[0] ?? 0;
  const ay = anchorEcef[1] ?? 0;
  const az = anchorEcef[2] ?? 0;
  sphere[0] = Math.sqrt(ax * ax + ay * ay + az * az);
  if (!sphereHit(eye, ray)) return false;
  for (let i = 0; i < 3; i++) hit[i] = (eye[i] ?? 0) + (sphere[1] ?? 0) * (ray[i] ?? 0);
  rotationBetween(hit, anchorEcef, rotation);
  const pose = camera.pose;
  // Heading: rotate the current horizontal viewing direction and measure it in the new target's local frame.
  position[0] = pose.targetLongitudeRad;
  position[1] = pose.targetLatitudeRad;
  enuFrameAtArray(position, enu);
  const sinH = Math.sin(pose.headingRad);
  const cosH = Math.cos(pose.headingRad);
  for (let i = 0; i < 3; i++) vector[i] = sinH * (enu[i] ?? 0) + cosH * (enu[3 + i] ?? 0);
  rotate(rotation, vector, ray);
  rotate(rotation, camera.targetEcef, hit);
  // The rotated target, converted exactly (it keeps its height above the ellipsoid only approximately).
  ecefArrayToGeodetic(hit, rotatedTarget);
  pose.targetLongitudeRad = rotatedTarget.longitudeRad;
  pose.targetLatitudeRad = rotatedTarget.latitudeRad;
  position[0] = pose.targetLongitudeRad;
  position[1] = pose.targetLatitudeRad;
  enuFrameAtArray(position, enu);
  const east = (ray[0] ?? 0) * (enu[0] ?? 0) + (ray[1] ?? 0) * (enu[1] ?? 0) + (ray[2] ?? 0) * (enu[2] ?? 0);
  const north = (ray[0] ?? 0) * (enu[3] ?? 0) + (ray[1] ?? 0) * (enu[4] ?? 0) + (ray[2] ?? 0) * (enu[5] ?? 0);
  if (east * east + north * north > 1e-18) pose.headingRad = Math.atan2(east, north);
  // The residual, in r0, tells the caller how close the rotation landed.
  return residual(camera, r0);
}

function rotate(m: Float64Array, v: Float64Array, out: Float64Array): void {
  const x = v[0] ?? 0;
  const y = v[1] ?? 0;
  const z = v[2] ?? 0;
  for (let row = 0; row < 3; row++)
    out[row] = (m[row * 3] ?? 0) * x + (m[row * 3 + 1] ?? 0) * y + (m[row * 3 + 2] ?? 0) * z;
}

/** The rotation about the origin taking direction `from` to direction `to` (Rodrigues), row-major 3×3. */
function rotationBetween(from: Float64Array, to: Float64Array, out: Float64Array): void {
  const fx = from[0] ?? 0;
  const fy = from[1] ?? 0;
  const fz = from[2] ?? 0;
  const tx = to[0] ?? 0;
  const ty = to[1] ?? 0;
  const tz = to[2] ?? 0;
  // Not Math.hypot: V8 boxes its arguments.
  const lengths = Math.sqrt(fx * fx + fy * fy + fz * fz) * Math.sqrt(tx * tx + ty * ty + tz * tz);
  const ax = (fy * tz - fz * ty) / lengths;
  const ay = (fz * tx - fx * tz) / lengths;
  const az = (fx * ty - fy * tx) / lengths;
  const cos = (fx * tx + fy * ty + fz * tz) / lengths;
  const k = 1 / (1 + cos);
  out[0] = cos + ax * ax * k;
  out[1] = ax * ay * k - az;
  out[2] = ax * az * k + ay;
  out[3] = ay * ax * k + az;
  out[4] = cos + ay * ay * k;
  out[5] = ay * az * k - ax;
  out[6] = az * ax * k - ay;
  out[7] = az * ay * k + ax;
  out[8] = cos + az * az * k;
}

/**
 * Whether a unit ray from `origin` meets the sphere of radius `sphere[0]` about the origin, in front of it; the
 * distance along the ray to the near hit goes to `sphere[1]`.
 */
function sphereHit(origin: Float64Array, direction: Float64Array): boolean {
  const radius = sphere[0] ?? 0;
  const b =
    (origin[0] ?? 0) * (direction[0] ?? 0) +
    (origin[1] ?? 0) * (direction[1] ?? 0) +
    (origin[2] ?? 0) * (direction[2] ?? 0);
  const c = (origin[0] ?? 0) ** 2 + (origin[1] ?? 0) ** 2 + (origin[2] ?? 0) ** 2 - radius * radius;
  const discriminant = b * b - c;
  if (discriminant < 0) return false;
  sphere[1] = -b - Math.sqrt(discriminant);
  return (sphere[1] ?? 0) >= 0;
}

import { geodeticToEcef } from '../geodesy/ecef.js';
import { enuFrame } from '../geodesy/enu.js';
import { wrapLongitudeRad } from '../projections/longitude.js';
import type { Camera } from './camera.js';
import { projectToScreen } from './projection.js';

const MAX_ITERATIONS = 6;
const TOLERANCE_PX = 0.01;
const ACCEPT_PX = 0.5;

const anchorEcef = new Float64Array(3);
const screen = new Float64Array(2);

/** Screen residual of the anchor for the camera's current pose, or undefined when it is behind the eye. */
function residual(camera: Camera, xPx: number, yPx: number, out: Float64Array): boolean {
  camera.update();
  if (!projectToScreen(camera, anchorEcef[0] ?? 0, anchorEcef[1] ?? 0, anchorEcef[2] ?? 0, screen)) return false;
  out[0] = (screen[0] ?? 0) - xPx;
  out[1] = (screen[1] ?? 0) - yPx;
  return true;
}

const r0 = new Float64Array(2);
const rLon = new Float64Array(2);
const rLat = new Float64Array(2);

/**
 * Moves the camera target so the geodetic anchor appears at the pixel, holding range, heading and tilt (ADR 0009 anchor
 * solver): Gauss–Newton on the target longitude and latitude with a finite-difference Jacobian. When it cannot converge
 * (the heading-held system is singular near the poles) it falls back to rotating the whole camera rigidly about the
 * Earth's center, which changes the heading. Returns false only if neither reaches the pixel.
 */
export function solveAnchor(
  camera: Camera,
  anchorLonRad: number,
  anchorLatRad: number,
  anchorHeightMeters: number,
  xPx: number,
  yPx: number,
): boolean {
  geodeticToEcef(anchorLonRad, anchorLatRad, anchorHeightMeters, anchorEcef);
  const pose = camera.pose;
  const startLon = pose.targetLongitudeRad;
  const startLat = pose.targetLatitudeRad;
  if (gaussNewton(camera, xPx, yPx)) return true;
  pose.targetLongitudeRad = startLon;
  pose.targetLatitudeRad = startLat;
  return rotateRigidly(camera, xPx, yPx);
}

function gaussNewton(camera: Camera, xPx: number, yPx: number): boolean {
  const pose = camera.pose;
  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    if (!residual(camera, xPx, yPx, r0)) return false;
    if (Math.hypot(r0[0] ?? 0, r0[1] ?? 0) < TOLERANCE_PX) return true;
    const step = Math.max(1e-12, (1e-6 * pose.rangeMeters) / 6.4e6);
    const lon = pose.targetLongitudeRad;
    const lat = pose.targetLatitudeRad;
    pose.targetLongitudeRad = lon + step;
    const okLon = residual(camera, xPx, yPx, rLon);
    pose.targetLongitudeRad = lon;
    pose.targetLatitudeRad = lat + step;
    const okLat = residual(camera, xPx, yPx, rLat);
    pose.targetLatitudeRad = lat;
    if (!okLon || !okLat) return false;
    const j00 = ((rLon[0] ?? 0) - (r0[0] ?? 0)) / step;
    const j10 = ((rLon[1] ?? 0) - (r0[1] ?? 0)) / step;
    const j01 = ((rLat[0] ?? 0) - (r0[0] ?? 0)) / step;
    const j11 = ((rLat[1] ?? 0) - (r0[1] ?? 0)) / step;
    const determinant = j00 * j11 - j01 * j10;
    if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-30) return false;
    const dLon = (j11 * (r0[0] ?? 0) - j01 * (r0[1] ?? 0)) / determinant;
    const dLat = (-j10 * (r0[0] ?? 0) + j00 * (r0[1] ?? 0)) / determinant;
    pose.targetLongitudeRad = wrapLongitudeRad(lon - dLon);
    pose.targetLatitudeRad = lat - dLat;
    if (Math.abs(pose.targetLatitudeRad) > Math.PI / 2 - 1e-9) return false;
  }
  if (!residual(camera, xPx, yPx, r0)) return false;
  return Math.hypot(r0[0] ?? 0, r0[1] ?? 0) < ACCEPT_PX;
}

const ray = new Float64Array(3);
const hit = new Float64Array(3);
const rotation = new Float64Array(9);
const enu = new Float64Array(9);
const vector = new Float64Array(3);

/** Rotates the camera about the Earth's center so the anchor moves under the pixel; updates the heading to match. */
function rotateRigidly(camera: Camera, xPx: number, yPx: number): boolean {
  camera.update();
  camera.rayDirection(xPx, yPx, ray);
  const eye = camera.eyeEcef;
  const distance = sphereHit(eye, ray, Math.hypot(anchorEcef[0] ?? 0, anchorEcef[1] ?? 0, anchorEcef[2] ?? 0));
  if (distance === undefined) return false;
  for (let i = 0; i < 3; i++) hit[i] = (eye[i] ?? 0) + distance * (ray[i] ?? 0);
  rotationBetween(hit, anchorEcef, rotation);
  const pose = camera.pose;
  // Heading: rotate the current horizontal viewing direction and measure it in the new target's local frame.
  enuFrame(pose.targetLongitudeRad, pose.targetLatitudeRad, enu);
  const sinH = Math.sin(pose.headingRad);
  const cosH = Math.cos(pose.headingRad);
  for (let i = 0; i < 3; i++) vector[i] = sinH * (enu[i] ?? 0) + cosH * (enu[3 + i] ?? 0);
  const heading = rotate(rotation, vector, ray);
  rotate(rotation, camera.targetEcef, hit);
  pose.targetLongitudeRad = Math.atan2(hit[1] ?? 0, hit[0] ?? 0);
  pose.targetLatitudeRad = Math.atan2(hit[2] ?? 0, Math.hypot(hit[0] ?? 0, hit[1] ?? 0) * (1 - 1 / 298.257223563) ** 2);
  enuFrame(pose.targetLongitudeRad, pose.targetLatitudeRad, enu);
  const east = dot(heading, enu, 0);
  const north = dot(heading, enu, 3);
  if (Math.hypot(east, north) > 1e-9) pose.headingRad = Math.atan2(east, north);
  camera.update();
  return true;
}

function dot(v: Float64Array, basis: Float64Array, offset: number): number {
  return (
    (v[0] ?? 0) * (basis[offset] ?? 0) + (v[1] ?? 0) * (basis[offset + 1] ?? 0) + (v[2] ?? 0) * (basis[offset + 2] ?? 0)
  );
}

function rotate(m: Float64Array, v: Float64Array, out: Float64Array): Float64Array {
  const x = v[0] ?? 0;
  const y = v[1] ?? 0;
  const z = v[2] ?? 0;
  for (let row = 0; row < 3; row++)
    out[row] = (m[row * 3] ?? 0) * x + (m[row * 3 + 1] ?? 0) * y + (m[row * 3 + 2] ?? 0) * z;
  return out;
}

/** The rotation about the origin taking direction `from` to direction `to` (Rodrigues), row-major 3×3. */
function rotationBetween(from: Float64Array, to: Float64Array, out: Float64Array): void {
  const fl = Math.hypot(from[0] ?? 0, from[1] ?? 0, from[2] ?? 0);
  const tl = Math.hypot(to[0] ?? 0, to[1] ?? 0, to[2] ?? 0);
  const ax = ((from[1] ?? 0) * (to[2] ?? 0) - (from[2] ?? 0) * (to[1] ?? 0)) / (fl * tl);
  const ay = ((from[2] ?? 0) * (to[0] ?? 0) - (from[0] ?? 0) * (to[2] ?? 0)) / (fl * tl);
  const az = ((from[0] ?? 0) * (to[1] ?? 0) - (from[1] ?? 0) * (to[0] ?? 0)) / (fl * tl);
  const cos =
    ((from[0] ?? 0) * (to[0] ?? 0) + (from[1] ?? 0) * (to[1] ?? 0) + (from[2] ?? 0) * (to[2] ?? 0)) / (fl * tl);
  const k = 1 / (1 + cos);
  out.set([
    cos + ax * ax * k,
    ax * ay * k - az,
    ax * az * k + ay,
    ay * ax * k + az,
    cos + ay * ay * k,
    ay * az * k - ax,
    az * ax * k - ay,
    az * ay * k + ax,
    cos + az * az * k,
  ]);
}

/** Distance along a unit ray to a sphere of the given radius about the origin, or undefined if it misses. */
function sphereHit(origin: Float64Array, direction: Float64Array, radius: number): number | undefined {
  const b =
    (origin[0] ?? 0) * (direction[0] ?? 0) +
    (origin[1] ?? 0) * (direction[1] ?? 0) +
    (origin[2] ?? 0) * (direction[2] ?? 0);
  const c = (origin[0] ?? 0) ** 2 + (origin[1] ?? 0) ** 2 + (origin[2] ?? 0) ** 2 - radius * radius;
  const discriminant = b * b - c;
  if (discriminant < 0) return undefined;
  const t = -b - Math.sqrt(discriminant);
  return t >= 0 ? t : undefined;
}

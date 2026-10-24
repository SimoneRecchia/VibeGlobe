// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * @hotpath Runs every frame of a drag or wheel zoom; doubles travel in preallocated arrays, never as call arguments or
 * return values, which V8 boxes (ADR 0018).
 * @benchmark packages/core/src/globe/frame-allocation.test.ts
 */
import { solveAnchor } from '../camera/anchor.js';
import type { Camera } from '../camera/camera.js';
import type { GeodeticRad } from '../geodesy/ecef.js';
import { wrapLongitudeRad } from '../projections/longitude.js';
import { clampPoseRange } from './camera-state.js';
import type { GeoPosition, ScreenPoint } from './types.js';
import { pickMorphedAt } from '../view/pick.js';
import type { ViewState } from '../view/view-state.js';

const RAD = Math.PI / 180;

const anchor = new Float64Array(3);
const pixel = new Float64Array(2);
const start = new Float64Array(3);
const pick: GeodeticRad = { longitudeRad: 0, latitudeRad: 0, heightMeters: 0 };

/**
 * Writes a screen point to `pixel` and returns whether it is one: an object with finite `xPx` and `yPx`. Finiteness is
 * tested as x − x === 0 (NaN for NaN and ±Infinity), not with Number.isFinite, which V8's mid-tier compiler calls with
 * a boxed argument. Navigation ignores invalid input instead of throwing (KB-029).
 */
function readPixel(point: unknown): boolean {
  if (point === null || typeof point !== 'object') return false;
  const x = (point as ScreenPoint).xPx;
  const y = (point as ScreenPoint).yPx;
  if (typeof x !== 'number' || typeof y !== 'number' || !(x - x === 0 && y - y === 0)) return false;
  pixel[0] = x;
  pixel[1] = y;
  return true;
}

/** Moves the camera so the point in `anchor` shows at `pixel`, or leaves it where it was when that is impossible. */
function solveDrag(camera: Camera, view: ViewState | undefined, guess?: Float64Array): void {
  const pose = camera.pose;
  start[0] = pose.targetLongitudeRad;
  start[1] = pose.targetLatitudeRad;
  start[2] = pose.headingRad;
  if (!solveAnchor(camera, anchor, pixel, view?.morph, guess)) {
    pose.targetLongitudeRad = start[0] ?? 0;
    pose.targetLatitudeRad = start[1] ?? 0;
    pose.headingRad = start[2] ?? 0;
  }
  const targetLon = pose.targetLongitudeRad;
  if (!(targetLon >= -Math.PI && targetLon < Math.PI)) pose.targetLongitudeRad = wrapLongitudeRad(targetLon);
  camera.update();
}

/** Moves the camera so a WGS84 position shows at a screen point; returns false for invalid input (nothing changes). */
export function dragCamera(camera: Camera, view: ViewState | undefined, position: unknown, point: unknown): boolean {
  if (position === null || typeof position !== 'object' || !readPixel(point)) return false;
  const lon = (position as GeoPosition).longitudeDeg;
  const lat = (position as GeoPosition).latitudeDeg;
  const height = (position as GeoPosition).heightMeters ?? 0;
  if (typeof lon !== 'number' || typeof lat !== 'number' || typeof height !== 'number') return false;
  if (!(lon - lon === 0 && lat - lat === 0 && height - height === 0)) return false;
  if (!(lat >= -90 && lat <= 90)) return false;
  anchor[0] = lon * RAD;
  anchor[1] = lat * RAD;
  anchor[2] = height;
  camera.update();
  view?.update(camera);
  solveDrag(camera, view);
  return true;
}

/** A zoom's second start for the anchor solver (KB-094): target longitude and latitude, radians; range; ratio. */
const zoomGuess = new Float64Array(4);

/**
 * A zoom's second start for the anchor solver (KB-094), into `zoomGuess[0..1]`: the target scaled toward the picked
 * point by the zoom's ratio (`zoomGuess[2]` holds the range before), exact on the flat map and close on the globe, for
 * a large step that leaves the point behind the eye from the unchanged target. Doubles stay in arrays (ADR 0018).
 */
function writeZoomGuess(camera: Camera): void {
  const pose = camera.pose;
  zoomGuess[3] = pose.rangeMeters / (zoomGuess[2] ?? 1);
  zoomGuess[0] = pose.targetLongitudeRad - pick.longitudeRad;
  if ((zoomGuess[0] ?? 0) > 3.141592653589793) zoomGuess[0] = (zoomGuess[0] ?? 0) - 6.283185307179586;
  else if ((zoomGuess[0] ?? 0) < -3.141592653589793) zoomGuess[0] = (zoomGuess[0] ?? 0) + 6.283185307179586;
  zoomGuess[0] = pick.longitudeRad + (zoomGuess[0] ?? 0) * (zoomGuess[3] ?? 1);
  if ((zoomGuess[0] ?? 0) >= 3.141592653589793) zoomGuess[0] = (zoomGuess[0] ?? 0) - 6.283185307179586;
  else if ((zoomGuess[0] ?? 0) < -3.141592653589793) zoomGuess[0] = (zoomGuess[0] ?? 0) + 6.283185307179586;
  zoomGuess[1] = pick.latitudeRad + (pose.targetLatitudeRad - pick.latitudeRad) * (zoomGuess[3] ?? 1);
}

/**
 * Zooms by `deltaZoom` levels keeping the position under a screen point there, or about the target when the point is
 * off the globe; returns false for invalid input (nothing changes).
 */
export function zoomCamera(camera: Camera, view: ViewState | undefined, point: unknown, deltaZoom: unknown): boolean {
  if (typeof deltaZoom !== 'number' || !(deltaZoom - deltaZoom === 0) || !readPixel(point)) return false;
  camera.update();
  // The point under the cursor as the frame shows it (ADR 0008: on the morphed surface).
  view?.update(camera);
  const anchored = view ? pickMorphedAt(camera, view.morph, pixel, pick) : camera.pickEllipsoidAt(pixel, pick);
  anchor[0] = pick.longitudeRad;
  anchor[1] = pick.latitudeRad;
  anchor[2] = 0;
  zoomGuess[2] = camera.pose.rangeMeters;
  camera.pose.rangeMeters *= 2 ** -deltaZoom;
  clampPoseRange(camera);
  if (anchored) writeZoomGuess(camera);
  camera.update();
  // The tilt the next frame applies at the new zoom (the Auto curve), so the point stays under the cursor (KB-098).
  view?.previewTilt(camera);
  // The new zoom has its own morph and relief: the point must stay under the cursor on that surface.
  view?.update(camera);
  if (anchored) solveDrag(camera, view, zoomGuess);
  return true;
}

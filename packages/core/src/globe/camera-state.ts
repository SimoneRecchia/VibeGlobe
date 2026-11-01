// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { Camera } from '../camera/camera.js';
import { cameraZoom, groundZoomFromMercatorZoom, rangeForGroundZoom } from '../camera/zoom.js';
import type { CameraState } from './types.js';
import type { ValidView } from './validation.js';
import type { ViewState } from '../view/view-state.js';
import { DEG_TO_RAD as RAD, RAD_TO_DEG as DEG } from '../geodesy/geodesic-angles.js';

/** The eye never goes lower than this above the ellipsoid (F061 reaches about 1 m). */
const MIN_EYE_HEIGHT_METERS = 0.5;
/** The farthest the camera may be from its target. */
const MAX_RANGE_METERS = 6e7;

/** Wraps degrees to [-180, 180). */
export function wrapDegrees(angleDeg: number): number {
  return angleDeg - 360 * Math.floor((angleDeg + 180) / 360);
}

/** Reads the public camera state from the camera (applied values, degrees, Mercator zoom). */
export function readCameraState(camera: Camera, view?: ViewState): CameraState {
  return writeCameraState(camera, newCameraState(), view);
}

/** A camera state whose fields can be overwritten, for a payload reused every frame. */
export type MutableCameraState = { -readonly [K in keyof CameraState]: CameraState[K] };

/** A state object to fill with {@link writeCameraState}; fractional initial values keep its fields doubles (ADR 0018). */
export function newCameraState(): MutableCameraState {
  return {
    longitudeDeg: 0.5,
    latitudeDeg: 0.5,
    zoom: 0.5,
    altitudeMeters: 0.5,
    headingDeg: 0.5,
    tiltDeg: 0.5,
    rollDeg: 0.5,
    rangeMeters: 0.5,
    eyeLongitudeDeg: 0.5,
    eyeLatitudeDeg: 0.5,
    groundHeightMeters: 0.5,
    viewMode: 'auto',
    chosenTiltDeg: 0.5,
    chosenHeadingDeg: 0.5,
    morphFactor: 0.5,
    reliefFactor: 0.5,
    phase: 'globe',
  };
}

/**
 * Writes the frame event's payload (F378): its frame number, the tiles drawn and the camera's Mercator zoom, without a
 * camera state object. Allocates nothing.
 */
export function writeFramePayload(
  camera: Camera,
  out: { frameNumber: number; tiles: number; zoom: number },
  frameNumber: number,
  tiles: number,
): void {
  out.frameNumber = frameNumber;
  out.tiles = tiles;
  out.zoom = cameraZoom(camera);
}

/** Writes the camera's public state into `out` and returns it; allocates nothing, so the frame loop can use it. */
export function writeCameraState(camera: Camera, out: MutableCameraState, view?: ViewState): MutableCameraState {
  const { pose } = camera;
  out.longitudeDeg = wrapDegrees(pose.targetLongitudeRad * DEG);
  out.latitudeDeg = pose.targetLatitudeRad * DEG;
  out.zoom = cameraZoom(camera);
  out.altitudeMeters = camera.eyeGeodetic.heightMeters;
  out.headingDeg = wrapDegrees(pose.headingRad * DEG);
  out.tiltDeg = pose.tiltRad * DEG;
  out.rollDeg = pose.rollRad * DEG;
  out.rangeMeters = pose.rangeMeters;
  out.eyeLongitudeDeg = wrapDegrees(camera.eyeGeodetic.longitudeRad * DEG);
  out.eyeLatitudeDeg = camera.eyeGeodetic.latitudeRad * DEG;
  out.groundHeightMeters = camera.groundHeightMeters;
  // The heading has no clamp: the applied heading is the chosen one (F164).
  out.viewMode = view ? view.mode : 'manual';
  out.chosenTiltDeg = view && view.mode === 'manual' ? view.chosenTiltRad * DEG : out.tiltDeg;
  out.chosenHeadingDeg = out.headingDeg;
  out.morphFactor = view ? (view.morph.factors[0] ?? 0) : 0;
  out.reliefFactor = view ? (view.morph.factors[1] ?? 1) : 1;
  out.phase = view ? view.phase : 'globe';
  return out;
}

/**
 * Applies a validated view to the camera pose. With `keepRange` the ground scale is kept and `view.zoom` is ignored, so
 * moving the target never changes the scale (ADR 0009: pans keep range).
 */
export function applyView(camera: Camera, view: ValidView, keepRange = false): void {
  const { pose } = camera;
  pose.targetLongitudeRad = wrapDegrees(view.longitudeDeg) * RAD;
  pose.targetLatitudeRad = view.latitudeDeg * RAD;
  pose.targetHeightMeters = 0;
  pose.headingRad = wrapDegrees(view.headingDeg) * RAD;
  pose.tiltRad = view.tiltDeg * RAD;
  if (keepRange) {
    // The kept range may be too short for the new tilt (KB-027).
    clampPoseRange(camera);
    return;
  }
  const groundZoom = groundZoomFromMercatorZoom(view.zoom, pose.targetLatitudeRad);
  pose.rangeMeters = rangeForGroundZoom(groundZoom, camera.heightPx, camera.fovYRad);
  clampPoseRange(camera);
}

/**
 * Clamps the pose's range so the eye stays at least {@link MIN_EYE_HEIGHT_METERS} above the ellipsoid, for per-frame
 * code too: the range never crosses a call boundary as an argument, and no Math.max or Math.min call boxes it (ADR
 * 0018).
 */
export function clampPoseRange(camera: Camera): void {
  const pose = camera.pose;
  const cos = Math.cos(pose.tiltRad);
  // No floor on the cosine beyond rounding: at the steepest allowed tilt (89°) the range must reach about 29 m (KB-015).
  const cosTilt = cos > 1e-9 ? cos : 1e-9;
  const below = pose.targetHeightMeters < 0 ? pose.targetHeightMeters : 0;
  // A micrometer of margin keeps float rounding from ever reporting the eye below the minimum.
  const minimum = (MIN_EYE_HEIGHT_METERS + 1e-6 - below) / cosTilt;
  const range = pose.rangeMeters;
  pose.rangeMeters = range < minimum ? minimum : range > MAX_RANGE_METERS ? MAX_RANGE_METERS : range;
}

/** The current view as validated fields, the base for partial updates. */
export function currentView(camera: Camera): ValidView {
  const { longitudeDeg, latitudeDeg, zoom, headingDeg, tiltDeg } = readCameraState(camera);
  return { longitudeDeg, latitudeDeg, zoom, headingDeg, tiltDeg };
}

/** The camera state of a view requested before the viewport has a size: range and altitude are not known yet. */
export function requestedCameraState(view: ValidView, state?: ViewState): CameraState {
  return {
    longitudeDeg: wrapDegrees(view.longitudeDeg),
    latitudeDeg: view.latitudeDeg,
    zoom: view.zoom,
    altitudeMeters: Number.NaN,
    headingDeg: wrapDegrees(view.headingDeg),
    tiltDeg: view.tiltDeg,
    rollDeg: 0,
    rangeMeters: Number.NaN,
    eyeLongitudeDeg: Number.NaN,
    eyeLatitudeDeg: Number.NaN,
    groundHeightMeters: 0,
    viewMode: state ? state.mode : 'manual',
    chosenTiltDeg: view.tiltDeg,
    chosenHeadingDeg: wrapDegrees(view.headingDeg),
    // Nothing is drawn yet: the factors and phase are those of the start state.
    morphFactor: state ? (state.morph.factors[0] ?? 0) : 0,
    reliefFactor: state ? (state.morph.factors[1] ?? 1) : 1,
    phase: state ? state.phase : 'globe',
  };
}

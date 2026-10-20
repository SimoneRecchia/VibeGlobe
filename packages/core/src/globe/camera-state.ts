import type { Camera } from '../camera/camera.js';
import {
  groundZoomForRange,
  groundZoomFromMercatorZoom,
  mercatorZoomFromGroundZoom,
  rangeForGroundZoom,
} from '../camera/zoom.js';
import type { CameraState } from './types.js';
import type { ValidView } from './validation.js';

const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;
/** The eye never goes lower than this above the ellipsoid (F061 reaches about 1 m). */
const MIN_EYE_HEIGHT_METERS = 0.5;
/** The farthest the camera may be from its target. */
const MAX_RANGE_METERS = 6e7;

/** Wraps degrees to [-180, 180). */
export function wrapDegrees(angleDeg: number): number {
  return angleDeg - 360 * Math.floor((angleDeg + 180) / 360);
}

/** Reads the public camera state from the camera (applied values, degrees, Mercator zoom). */
export function readCameraState(camera: Camera): CameraState {
  const { pose } = camera;
  const groundZoom = groundZoomForRange(pose.rangeMeters, camera.heightPx, camera.fovYRad);
  return {
    longitudeDeg: wrapDegrees(pose.targetLongitudeRad * DEG),
    latitudeDeg: pose.targetLatitudeRad * DEG,
    zoom: mercatorZoomFromGroundZoom(groundZoom, pose.targetLatitudeRad),
    altitudeMeters: camera.eyeGeodetic.heightMeters,
    headingDeg: wrapDegrees(pose.headingRad * DEG),
    tiltDeg: pose.tiltRad * DEG,
    rollDeg: pose.rollRad * DEG,
    rangeMeters: pose.rangeMeters,
  };
}

/** Applies a validated view to the camera pose. */
export function applyView(camera: Camera, view: ValidView): void {
  const { pose } = camera;
  pose.targetLongitudeRad = wrapDegrees(view.longitudeDeg) * RAD;
  pose.targetLatitudeRad = view.latitudeDeg * RAD;
  pose.targetHeightMeters = 0;
  pose.headingRad = wrapDegrees(view.headingDeg) * RAD;
  pose.tiltRad = view.tiltDeg * RAD;
  const groundZoom = groundZoomFromMercatorZoom(view.zoom, pose.targetLatitudeRad);
  pose.rangeMeters = clampRange(camera, rangeForGroundZoom(groundZoom, camera.heightPx, camera.fovYRad));
}

/** Clamps a range so the eye stays at least {@link MIN_EYE_HEIGHT_METERS} above the ellipsoid. */
export function clampRange(camera: Camera, rangeMeters: number): number {
  const cosTilt = Math.max(Math.cos(camera.pose.tiltRad), 0.05);
  const minimum = (MIN_EYE_HEIGHT_METERS - Math.min(camera.pose.targetHeightMeters, 0)) / cosTilt;
  return Math.min(MAX_RANGE_METERS, Math.max(minimum, rangeMeters));
}

/** The current view as validated fields, the base for partial updates. */
export function currentView(camera: Camera): ValidView {
  const state = readCameraState(camera);
  return {
    longitudeDeg: state.longitudeDeg,
    latitudeDeg: state.latitudeDeg,
    zoom: state.zoom,
    headingDeg: state.headingDeg,
    tiltDeg: state.tiltDeg,
  };
}

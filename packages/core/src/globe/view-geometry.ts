import type { Camera } from '../camera/camera.js';
import { projectToScreen } from '../camera/projection.js';
import { groundZoomFromMercatorZoom, mercatorZoomFromGroundZoom } from '../camera/zoom.js';
import { geodeticToEcef, type GeodeticRad } from '../geodesy/ecef.js';
import { wrapDegrees } from './camera-state.js';
import type { GeoPosition, ScreenPoint } from './types.js';
import type { ValidView } from './validation.js';

const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;
const ecefScratch = new Float64Array(3);
const screenScratch = new Float64Array(2);
const pick: GeodeticRad = { longitudeRad: 0, latitudeRad: 0, heightMeters: 0 };

/** The ellipsoid position under a screen point of an up-to-date camera, or undefined off the globe. */
export function positionAt(camera: Camera, point: ScreenPoint): GeoPosition | undefined {
  if (!camera.pickEllipsoid(point.xPx, point.yPx, pick)) return undefined;
  return { longitudeDeg: wrapDegrees(pick.longitudeRad * DEG), latitudeDeg: pick.latitudeRad * DEG, heightMeters: 0 };
}

/** The screen point showing a position for an up-to-date camera, or undefined behind it. */
export function screenOf(camera: Camera, position: GeoPosition): ScreenPoint | undefined {
  geodeticToEcef(position.longitudeDeg * RAD, position.latitudeDeg * RAD, position.heightMeters ?? 0, ecefScratch);
  if (!projectToScreen(camera, ecefScratch, screenScratch)) return undefined;
  return { xPx: screenScratch[0] ?? 0, yPx: screenScratch[1] ?? 0 };
}

/** Gives a position-only jump requested before start the ground scale of the view it replaces. */
export function keepGroundScale(from: ValidView, view: ValidView): void {
  const groundZoom = groundZoomFromMercatorZoom(from.zoom, from.latitudeDeg * RAD);
  view.zoom = mercatorZoomFromGroundZoom(groundZoom, view.latitudeDeg * RAD);
}

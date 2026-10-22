import type { Camera } from '../camera/camera.js';
import { projectToScreen } from '../camera/projection.js';
import { groundZoomFromMercatorZoom, mercatorZoomFromGroundZoom } from '../camera/zoom.js';
import type { GeodeticRad } from '../geodesy/ecef.js';
import { wrapDegrees } from './camera-state.js';
import type { GeoPosition, ScreenPoint } from './types.js';
import type { ValidView } from './validation.js';
import { morphPointInto, type MorphFrame } from '../view/morph.js';
import { pickMorphedAt } from '../view/pick.js';
import type { ViewState } from '../view/view-state.js';

const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;
const ecefScratch = new Float64Array(3);
const screenScratch = new Float64Array(2);
const pick: GeodeticRad = { longitudeRad: 0, latitudeRad: 0, heightMeters: 0 };
const pixel = new Float64Array(2);
const geodetic = new Float64Array(3);

/**
 * The position under a screen point as the frame shows it (ADR 0008: on the morphed surface, measured on the
 * ellipsoid), for an up-to-date camera and view state, or undefined off the surface.
 */
export function positionAt(camera: Camera, view: ViewState, point: ScreenPoint): GeoPosition | undefined {
  pixel[0] = point.xPx;
  pixel[1] = point.yPx;
  if (!pickMorphedAt(camera, view.morph, pixel, pick)) return undefined;
  return { longitudeDeg: wrapDegrees(pick.longitudeRad * DEG), latitudeDeg: pick.latitudeRad * DEG, heightMeters: 0 };
}

/** The screen point showing a position as the frame draws it, for an up-to-date camera and view, or undefined behind it. */
export function screenOf(camera: Camera, view: ViewState, position: GeoPosition): ScreenPoint | undefined {
  geodetic[0] = position.longitudeDeg * RAD;
  geodetic[1] = position.latitudeDeg * RAD;
  geodetic[2] = position.heightMeters ?? 0;
  morphPointInto(view.morph, geodetic, ecefScratch);
  if (!projectToScreen(camera, ecefScratch, screenScratch)) return undefined;
  return { xPx: screenScratch[0] ?? 0, yPx: screenScratch[1] ?? 0 };
}

/** Gives a position-only jump requested before start the ground scale of the view it replaces. */
export function keepGroundScale(from: ValidView, view: ValidView): void {
  const groundZoom = groundZoomFromMercatorZoom(from.zoom, from.latitudeDeg * RAD);
  view.zoom = mercatorZoomFromGroundZoom(groundZoom, view.latitudeDeg * RAD);
}

/** The frame view the engine hands the renderer, updated in place each frame. */
export interface MutableFrameView {
  readonly morph: MorphFrame;
  readonly view: Float64Array;
  readonly projection: Float64Array;
  readonly eyeEcef: Float64Array;
  widthPx: number;
  heightPx: number;
  pixelRatio: number;
}

/** A frame view sharing the camera's matrices and the frame's morph, so updating those updates it. */
export function createFrameView(camera: Camera, morph: MorphFrame): MutableFrameView {
  return {
    morph,
    view: camera.view,
    projection: camera.projection,
    eyeEcef: camera.eyeEcef,
    widthPx: 1,
    heightPx: 1,
    pixelRatio: 1,
  };
}

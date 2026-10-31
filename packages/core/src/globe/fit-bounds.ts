// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { Camera } from '../camera/camera.js';
import { groundZoomFromMercatorZoom, rangeForGroundZoom } from '../camera/zoom.js';
import { ViewState } from '../view/view-state.js';
import { GlobeError } from './errors.js';
import type { GeoBounds, GeoPosition } from './types.js';
import { screenOf } from './view-geometry.js';

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;
/** Web Mercator's latitude limit, degrees: a fitted center stays within it. */
const MAX_LATITUDE_DEG = 85.0511287798066;
/** Samples per bounds edge, corners included. */
const EDGE_SAMPLES = 9;
/** The zoom range searched, and the bisection steps (2⁻²⁰ of it: far below a pixel). */
const MIN_ZOOM = 0;
const MAX_ZOOM = 22;
const STEPS = 20;
/** The nearest a fit brings the eye to the middle of what it frames, meters: a lone point is seen with its ground. */
const MIN_FIT_DISTANCE_METERS = 100;
/** The equatorial radius, meters, for the few hundred meters a fitted center moves. */
const EARTH_RADIUS_METERS = 6_378_137;

/** Throws a GlobeError unless `bounds` are finite degrees with south ≤ north; east < west crosses the antimeridian. */
export function validateBounds(bounds: unknown): GeoBounds {
  const b = bounds as Partial<GeoBounds> | null;
  const values = [b?.westDeg, b?.southDeg, b?.eastDeg, b?.northDeg];
  if (
    b === null ||
    typeof b !== 'object' ||
    !values.every((value) => typeof value === 'number' && Number.isFinite(value)) ||
    Math.abs(b.southDeg ?? 0) > 90 ||
    Math.abs(b.northDeg ?? 0) > 90 ||
    (b.southDeg ?? 0) > (b.northDeg ?? 0) ||
    Math.abs(b.westDeg ?? 0) > 180 ||
    Math.abs(b.eastDeg ?? 0) > 180
  )
    throw new GlobeError(
      'invalid-coordinate',
      'Bounds need finite westDeg, southDeg, eastDeg and northDeg within ±180° and ±90°, with southDeg ≤ northDeg',
    );
  return b as GeoBounds;
}

/** Web Mercator y of a latitude (clamped to the projection's limit), unitless. */
function mercatorY(latDeg: number): number {
  const lat = Math.max(-MAX_LATITUDE_DEG, Math.min(MAX_LATITUDE_DEG, latDeg)) * RAD;
  return Math.log(Math.tan(Math.PI / 4 + lat / 2));
}

function latitudeOfY(y: number): number {
  return (2 * Math.atan(Math.exp(y)) - Math.PI / 2) * DEG;
}

/** Points along the four edges of `bounds` (`width` degrees wide), corners included: parallels and meridians. */
function edgeSamples(bounds: GeoBounds, width: number): { longitudeDeg: number; latitudeDeg: number }[] {
  const samples: { longitudeDeg: number; latitudeDeg: number }[] = [];
  for (let i = 0; i < EDGE_SAMPLES; i++) {
    const f = i / (EDGE_SAMPLES - 1);
    const lon = bounds.westDeg + f * width;
    const lat = latitudeOfY(mercatorY(bounds.southDeg) + f * (mercatorY(bounds.northDeg) - mercatorY(bounds.southDeg)));
    samples.push(
      { longitudeDeg: lon > 180 ? lon - 360 : lon, latitudeDeg: bounds.southDeg },
      { longitudeDeg: lon > 180 ? lon - 360 : lon, latitudeDeg: bounds.northDeg },
      { longitudeDeg: bounds.westDeg, latitudeDeg: lat },
      { longitudeDeg: bounds.eastDeg, latitudeDeg: lat },
    );
  }
  return samples;
}

/**
 * The view that shows `bounds` inside the viewport minus `paddingPx` on every side, with the camera's heading and the
 * tilt the view mode applies there (F176): centered on the bounds' Web Mercator middle (across the antimeridian when
 * east < west), at the largest zoom where every corner and edge sample projects inside the padded viewport, using the
 * engine's own projection through the globe-to-flat morph; `include` adds positions (with heights) that must fit too,
 * and `tiltDeg` replaces the view mode's tilt.
 * Works on copies: the camera and view state are untouched.
 */
export function viewForBounds(
  camera: Camera,
  view: ViewState,
  bounds: GeoBounds,
  paddingPx: number,
  include: readonly GeoPosition[] = [],
  tiltDeg?: number,
): { longitudeDeg: number; latitudeDeg: number; zoom: number } {
  const width =
    bounds.eastDeg >= bounds.westDeg ? bounds.eastDeg - bounds.westDeg : bounds.eastDeg + 360 - bounds.westDeg;
  const lon = (bounds.westDeg + width / 2) * RAD;
  const lat =
    Math.max(
      -MAX_LATITUDE_DEG,
      Math.min(MAX_LATITUDE_DEG, latitudeOfY((mercatorY(bounds.southDeg) + mercatorY(bounds.northDeg)) / 2)),
    ) * RAD;
  // The bounds lie at the lowest of the included positions (their ground), and the view aims at the middle of their
  // heights, so a tall object stands centered (KB-300).
  const heights = include.map((p) => p.heightMeters ?? 0);
  const low = heights.length > 0 ? Math.min(...heights) : 0;
  const middle = (low + (heights.length > 0 ? Math.max(...heights) : 0)) / 2;
  const samples = [...edgeSamples(bounds, width).map((sample) => ({ ...sample, heightMeters: low })), ...include];
  const { probe, fit } = probeOf(camera, view);
  if (tiltDeg !== undefined) fit.chooseTilt(tiltDeg * RAD);
  const pose = probe.pose;
  pose.targetLatitudeRad = lat;
  const fits = (zoom: number): boolean => {
    pose.rangeMeters = rangeForGroundZoom(groundZoomFromMercatorZoom(zoom, lat), probe.heightPx, probe.fovYRad);
    probe.update();
    fit.previewTilt(probe);
    // The aim point is where the view's central ray, through the middle of the heights, meets the ellipsoid; the eye
    // is that much nearer the middle than the aim point.
    const ahead = (middle * Math.tan(pose.tiltRad)) / EARTH_RADIUS_METERS;
    pose.targetLatitudeRad = lat + ahead * Math.cos(pose.headingRad);
    pose.targetLongitudeRad = lon + (ahead * Math.sin(pose.headingRad)) / Math.cos(lat);
    if (pose.rangeMeters - middle / Math.cos(pose.tiltRad) < MIN_FIT_DISTANCE_METERS) return false;
    return samples.every((sample) => inside(screenOf(probe, fit, sample), probe, paddingPx));
  };
  let lowest = MIN_ZOOM;
  let high = MAX_ZOOM;
  if (fits(high)) lowest = high;
  for (let step = 0; step < STEPS && high - lowest > 0; step++) {
    const zoom = (lowest + high) / 2;
    if (fits(zoom)) lowest = zoom;
    else high = zoom;
  }
  // The aim point of the zoom found.
  fits(lowest);
  const longitudeDeg = pose.targetLongitudeRad * DEG;
  return {
    longitudeDeg: longitudeDeg >= 180 ? longitudeDeg - 360 : longitudeDeg,
    latitudeDeg: pose.targetLatitudeRad * DEG,
    zoom: lowest,
  };
}

/** A camera and a view state like the globe's, to try views on: same viewport, heading and view mode. */
function probeOf(camera: Camera, view: ViewState): { probe: Camera; fit: ViewState } {
  const probe = new Camera();
  probe.widthPx = camera.widthPx;
  probe.heightPx = camera.heightPx;
  probe.fovYRad = camera.fovYRad;
  probe.pose.headingRad = camera.pose.headingRad;
  const fit = new ViewState(view.curves);
  if (view.mode === 'manual') fit.chooseTilt(view.chosenTiltRad);
  else if (view.mode === '2d') fit.setMode('2d');
  return { probe, fit };
}

/** Whether a screen point lies inside the viewport less `paddingPx` on every side. */
function inside(point: { xPx: number; yPx: number } | undefined, probe: Camera, paddingPx: number): boolean {
  return (
    point !== undefined &&
    point.xPx >= paddingPx - 1e-6 &&
    point.xPx <= probe.widthPx - paddingPx + 1e-6 &&
    point.yPx >= paddingPx - 1e-6 &&
    point.yPx <= probe.heightPx - paddingPx + 1e-6
  );
}

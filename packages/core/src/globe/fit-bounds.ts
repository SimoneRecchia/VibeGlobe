// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { Camera } from '../camera/camera.js';
import { groundZoomFromMercatorZoom, rangeForGroundZoom } from '../camera/zoom.js';
import { ViewState } from '../view/view-state.js';
import { GlobeError } from './errors.js';
import type { GeoBounds, GeoPosition, ScreenInsets } from './types.js';
import { screenOf } from './view-geometry.js';
import { projectWebMercatorDeg, unprojectWebMercatorDeg } from '../projections/web-mercator.js';
import { DEG_TO_RAD as RAD, RAD_TO_DEG as DEG } from '../geodesy/geodesic-angles.js';

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
/** The step, radians, by which a padding heavier on one side measures how the framed middle moves on screen. */
const PROBE_RAD = 1e-6;

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

/** Web Mercator y of a latitude (clamped to the projection's limit), meters. */
const yOf = (latDeg: number): number => projectWebMercatorDeg(0, latDeg).yMeters;
const latitudeOfY = (yMeters: number): number => unprojectWebMercatorDeg(0, yMeters).latDeg;

/** Points along the four edges of `bounds` (`width` degrees wide), corners included: parallels and meridians. */
function edgeSamples(bounds: GeoBounds, width: number): { longitudeDeg: number; latitudeDeg: number }[] {
  const samples: { longitudeDeg: number; latitudeDeg: number }[] = [];
  const south = yOf(bounds.southDeg);
  const north = yOf(bounds.northDeg);
  for (let i = 0; i < EDGE_SAMPLES; i++) {
    const f = i / (EDGE_SAMPLES - 1);
    const lon = bounds.westDeg + f * width;
    const longitudeDeg = lon > 180 ? lon - 360 : lon;
    const latitudeDeg = latitudeOfY(south + f * (north - south));
    samples.push(
      { longitudeDeg, latitudeDeg: bounds.southDeg },
      { longitudeDeg, latitudeDeg: bounds.northDeg },
      { longitudeDeg: bounds.westDeg, latitudeDeg },
      { longitudeDeg: bounds.eastDeg, latitudeDeg },
    );
  }
  return samples;
}

/**
 * The view that shows `bounds` inside the viewport minus `padding`, with the camera's heading and the tilt the view
 * mode applies there (F176): centered on the bounds' Web Mercator middle (across the antimeridian when east < west), at
 * the largest zoom where every corner and edge sample projects inside the padded viewport, using the engine's own
 * projection through the globe-to-flat morph; `include` adds positions (with heights) that must fit too, and `tiltDeg`
 * replaces the view mode's tilt. A padding heavier on one side frames in the part it leaves, centered there (F676).
 * Works on copies: the camera and view state are untouched.
 */
export function viewForBounds(
  camera: Camera,
  view: ViewState,
  bounds: GeoBounds,
  padding: ScreenInsets,
  include: readonly GeoPosition[] = [],
  tiltDeg?: number,
): { longitudeDeg: number; latitudeDeg: number; zoom: number } {
  const width =
    bounds.eastDeg >= bounds.westDeg ? bounds.eastDeg - bounds.westDeg : bounds.eastDeg + 360 - bounds.westDeg;
  const lon = (bounds.westDeg + width / 2) * RAD;
  const lat = latitudeOfY((yOf(bounds.southDeg) + yOf(bounds.northDeg)) / 2) * RAD;
  // The bounds lie at the lowest of the included positions (their ground), and the view aims at the middle of their
  // heights, so a tall object stands centered (KB-301).
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
    center(probe, fit, { lon, lat, middle }, padding);
    return samples.every((sample) => inside(screenOf(probe, fit, sample), probe, padding));
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

/** Whether a screen point lies inside the viewport less the padding. */
function inside(point: { xPx: number; yPx: number } | undefined, probe: Camera, padding: ScreenInsets): boolean {
  return (
    point !== undefined &&
    point.xPx >= padding.left - 1e-6 &&
    point.xPx <= probe.widthPx - padding.right + 1e-6 &&
    point.yPx >= padding.top - 1e-6 &&
    point.yPx <= probe.heightPx - padding.bottom + 1e-6
  );
}

/**
 * Moves the aim so the framed middle (radians, height in meters) shows at the middle of the padded part (F676): the
 * screen offset is turned into an aim offset through how the middle moves for a small step east and north at its
 * height, which counts tilt and parallax, a few times over for the perspective. An even padding moves nothing.
 */
function center(
  probe: Camera,
  fit: ViewState,
  framed: { lon: number; lat: number; middle: number },
  { top, right, bottom, left }: ScreenInsets,
): void {
  const at = (east: number, north: number) =>
    screenOf(probe, fit, {
      longitudeDeg: (framed.lon + east) * DEG,
      latitudeDeg: (framed.lat + north) * DEG,
      heightMeters: framed.middle,
    });
  for (let step = 0; step < 3 && (left !== right || top !== bottom); step++) {
    const [p, e, n] = [at(0, 0), at(PROBE_RAD, 0), at(0, PROBE_RAD)];
    if (!p || !e || !n) return;
    const [ex, ey, nx, ny] = [e.xPx - p.xPx, e.yPx - p.yPx, n.xPx - p.xPx, n.yPx - p.yPx];
    const dx = (probe.widthPx + left - right) / 2 - p.xPx;
    const dy = (probe.heightPx + top - bottom) / 2 - p.yPx;
    const scale = PROBE_RAD / (ex * ny - nx * ey);
    // Aiming further east moves what is framed as far west on screen.
    probe.pose.targetLongitudeRad -= (dx * ny - nx * dy) * scale;
    probe.pose.targetLatitudeRad -= (ex * dy - ey * dx) * scale;
  }
}

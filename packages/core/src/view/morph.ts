import { geodeticArrayToEcef } from '../geodesy/ecef.js';
import { enuFrameAtArray } from '../geodesy/enu.js';
import { WGS84 } from '../geodesy/wgs84.js';
import { WEB_MERCATOR_HALF_EXTENT_METERS, WEB_MERCATOR_MAX_LATITUDE_RAD } from '../projections/web-mercator.js';

const A = WGS84.semiMajorAxisMeters;
const E2 = WGS84.firstEccentricitySquared;
const WORLD_METERS = 2 * WEB_MERCATOR_HALF_EXTENT_METERS;
/** dy/dφ of Web Mercator at its latitude limit, a / cos φ_lim = a·cosh(π): the slope the capped strip continues. */
const CAP_SLOPE_METERS_PER_RAD = A * Math.cosh(Math.PI);

/**
 * Capped Web Mercator (ADR 0008, poles): x = a·λ and y = a·asinh(tan φ) within ±85.0511°, continued linearly beyond
 * with the slope at the limit, so the polar caps stay on the flat map with a C¹ seam. Reads longitude and latitude
 * (radians) from `lonLat[0..1]` and writes x and y (meters) to `out[0..1]`. Allocates nothing.
 */
export function cappedMercatorInto(lonLat: Float64Array, out: Float64Array): void {
  const lonRad = lonLat[0] ?? 0;
  const latRad = lonLat[1] ?? 0;
  out[0] = A * lonRad;
  if (latRad > WEB_MERCATOR_MAX_LATITUDE_RAD)
    out[1] = WEB_MERCATOR_HALF_EXTENT_METERS + (latRad - WEB_MERCATOR_MAX_LATITUDE_RAD) * CAP_SLOPE_METERS_PER_RAD;
  else if (latRad < -WEB_MERCATOR_MAX_LATITUDE_RAD)
    out[1] = -WEB_MERCATOR_HALF_EXTENT_METERS + (latRad + WEB_MERCATOR_MAX_LATITUDE_RAD) * CAP_SLOPE_METERS_PER_RAD;
  else out[1] = A * Math.asinh(Math.tan(latRad));
}

/**
 * Map meters per ground meter of Web Mercator on the WGS84 ellipsoid (ADR 0008, relief): k(φ) = √(1 − e² sin² φ) / cos φ
 * (the parallel's true length is N·cos φ), with the latitude clamped to the projection's limit. Reads φ from `lat[0]`
 * and writes k to `lat[1]`.
 */
export function mercatorScaleInto(lat: Float64Array): void {
  const raw = lat[0] ?? 0;
  const latRad =
    raw > WEB_MERCATOR_MAX_LATITUDE_RAD
      ? WEB_MERCATOR_MAX_LATITUDE_RAD
      : raw < -WEB_MERCATOR_MAX_LATITUDE_RAD
        ? -WEB_MERCATOR_MAX_LATITUDE_RAD
        : raw;
  const sin = Math.sin(latRad);
  lat[1] = Math.sqrt(1 - E2 * sin * sin) / Math.cos(latRad);
}

/** `x` minus `reference` wrapped into [−half a world, half a world): the world copy nearest the reference. */
function wrapDeltaMeters(x: number, reference: number): number {
  let delta = x - reference;
  delta -= WORLD_METERS * Math.floor((delta + WEB_MERCATOR_HALF_EXTENT_METERS) / WORLD_METERS);
  return delta;
}

const scratch = new Float64Array(3);
const plane = new Float64Array(2);
const scale = new Float64Array(2);
const globe = new Float64Array(3);

/**
 * The state of the globe-to-flat morph for one frame (ADR 0008, option 5): the anchor (the camera target) and its
 * east-north-up frame, the morph factor m (0 globe, 1 flat map), the relief factor r and σ = 1 / k(φ_anchor). The plane
 * is the anchor's tangent plane, mapped into ECEF through the frame, so the engine's eye-relative ECEF world space holds
 * at every m. Every member is a float64 array or number set by {@link MorphFrame.update}; nothing allocates per frame.
 */
export class MorphFrame {
  /** Morph factor: 0 the globe, 1 the flat map. */
  morph = 0;
  /** Relief factor: heights are multiplied by it on both endpoints. */
  relief = 1;
  /** 1 / k(φ_anchor): plane meters per Mercator meter, so the map is true to scale at the anchor. */
  sigma = 1;
  /** Anchor longitude and latitude, radians. */
  readonly anchor = new Float64Array(2);
  /** Anchor on the ellipsoid, ECEF meters. */
  readonly anchorEcef = new Float64Array(3);
  /** The anchor's east, north and up axes in ECEF, column-major (columns east, north, up). */
  readonly axes = new Float64Array(9);
  /** The anchor's capped-Mercator x and y, meters. */
  readonly anchorMercator = new Float64Array(2);

  /**
   * Sets the frame from the anchor's longitude and latitude (radians) in `anchor[0..1]` and the factors in
   * `factors[0]` (morph) and `factors[1]` (relief).
   */
  update(anchor: Float64Array, factors: Float64Array): void {
    this.anchor[0] = anchor[0] ?? 0;
    this.anchor[1] = anchor[1] ?? 0;
    this.morph = factors[0] ?? 0;
    this.relief = factors[1] ?? 1;
    scratch[0] = this.anchor[0];
    scratch[1] = this.anchor[1];
    scratch[2] = 0;
    geodeticArrayToEcef(scratch, this.anchorEcef);
    enuFrameAtArray(this.anchor, this.axes);
    cappedMercatorInto(this.anchor, this.anchorMercator);
    scale[0] = this.anchor[1];
    mercatorScaleInto(scale);
    this.sigma = 1 / (scale[1] ?? 1);
  }

  /**
   * Writes the plane endpoint of a vertex at Mercator `mercator[0..1]` (meters) with scaled height `mercator[2]`
   * (h·k(φ), meters) into `out[0..2]`, ECEF: E(a) + R_Aᵀ·σ·(wrap(x − x_a), y − y_a, r·h·k).
   */
  planeEndpointInto(mercator: Float64Array, out: Float64Array): void {
    const s = this.sigma;
    const east = s * wrapDeltaMeters(mercator[0] ?? 0, this.anchorMercator[0] ?? 0);
    const north = s * ((mercator[1] ?? 0) - (this.anchorMercator[1] ?? 0));
    const up = s * this.relief * (mercator[2] ?? 0);
    const axes = this.axes;
    for (let i = 0; i < 3; i++)
      out[i] = (this.anchorEcef[i] ?? 0) + east * (axes[i] ?? 0) + north * (axes[3 + i] ?? 0) + up * (axes[6 + i] ?? 0);
  }
}

/**
 * The morphed position of a geodetic point (longitude, latitude in radians, height in meters, read from
 * `geodetic[0..2]`) for `frame`, ECEF meters into `out[0..2]`: (1 − m)·E(φ, λ, r·h) + m·P (ADR 0008). The float64
 * reference of the vertex shader, for picking, culling, collision and anchoring. Allocates nothing.
 */
export function morphPointInto(frame: MorphFrame, geodetic: Float64Array, out: Float64Array): void {
  const m = frame.morph;
  const height = geodetic[2] ?? 0;
  scratch[0] = geodetic[0] ?? 0;
  scratch[1] = geodetic[1] ?? 0;
  scratch[2] = frame.relief * height;
  geodeticArrayToEcef(scratch, globe);
  if (m === 0) {
    out[0] = globe[0] ?? 0;
    out[1] = globe[1] ?? 0;
    out[2] = globe[2] ?? 0;
    return;
  }
  cappedMercatorInto(geodetic, plane);
  scale[0] = geodetic[1] ?? 0;
  mercatorScaleInto(scale);
  scratch[0] = plane[0] ?? 0;
  scratch[1] = plane[1] ?? 0;
  scratch[2] = height * (scale[1] ?? 1);
  frame.planeEndpointInto(scratch, out);
  // Written out, never as a mix: (1 − m)·G + m·P (ADR 0008).
  for (let i = 0; i < 3; i++) out[i] = (1 - m) * (globe[i] ?? 0) + m * (out[i] ?? 0);
}

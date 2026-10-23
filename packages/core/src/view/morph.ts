import { geodeticArrayToEcef } from '../geodesy/ecef.js';
import { enuFrameAtArray } from '../geodesy/enu.js';
import { WGS84 } from '../geodesy/wgs84.js';

const A = WGS84.semiMajorAxisMeters;
/**
 * The Web Mercator limits (`WEB_MERCATOR_MAX_LATITUDE_RAD`, `WEB_MERCATOR_HALF_EXTENT_METERS`) as constants of this
 * module: per-frame code that compares with an imported binding boxes the double it compares (measured, ADR 0018).
 */
const LIMIT_RAD = 1.4844222297453324;
const HALF_EXTENT_METERS = 20037508.342789244;
const HALF_PI = 1.5707963267948966;
const PI = 3.141592653589793;
const TWO_PI = 6.283185307179586;
const PI_A = PI * A;
const E2 = WGS84.firstEccentricitySquared;
const WORLD_METERS = 2 * HALF_EXTENT_METERS;
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
  if (latRad > LIMIT_RAD) out[1] = HALF_EXTENT_METERS + (latRad - LIMIT_RAD) * CAP_SLOPE_METERS_PER_RAD;
  else if (latRad < -LIMIT_RAD) out[1] = -HALF_EXTENT_METERS + (latRad + LIMIT_RAD) * CAP_SLOPE_METERS_PER_RAD;
  else out[1] = A * Math.asinh(Math.tan(latRad));
}

/**
 * Map meters per ground meter of Web Mercator on the WGS84 ellipsoid (ADR 0008, relief): k(φ) = √(1 − e² sin² φ) / cos φ
 * (the parallel's true length is N·cos φ), with the latitude clamped to the projection's limit. Reads φ from `lat[0]`
 * and writes k to `lat[1]`.
 */
export function mercatorScaleInto(lat: Float64Array): void {
  const raw = lat[0] ?? 0;
  const latRad = raw > LIMIT_RAD ? LIMIT_RAD : raw < -LIMIT_RAD ? -LIMIT_RAD : raw;
  const sin = Math.sin(latRad);
  lat[1] = Math.sqrt(1 - E2 * sin * sin) / Math.cos(latRad);
}

/**
 * `x` minus `reference` wrapped into [−half a world, half a world), the world copy nearest the reference: reads x and
 * the reference from `io[0..1]` and writes the difference to `io[2]`, so no double crosses the call (ADR 0018).
 */
export function wrapDeltaInto(io: Float64Array): void {
  let delta = (io[0] ?? 0) - (io[1] ?? 0);
  delta -= WORLD_METERS * Math.floor((delta + HALF_EXTENT_METERS) / WORLD_METERS);
  io[2] = delta;
}

/** Writes 1 / k(φ) for the latitude in `lat[0]` to `lat[1]`, without a call (see {@link mercatorScaleInto}). */
function inverseScaleInto(lat: Float64Array): void {
  const raw = lat[0] ?? 0;
  let latRad = raw;
  if (latRad > LIMIT_RAD) latRad = LIMIT_RAD;
  if (latRad < -LIMIT_RAD) latRad = -LIMIT_RAD;
  const sin = Math.sin(latRad);
  lat[1] = Math.cos(latRad) / Math.sqrt(1 - E2 * sin * sin);
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
  /** Morph factor, relief factor and σ, in an array: a double stored in a field may be boxed (ADR 0018). */
  readonly factors = Float64Array.of(0, 1, 1);

  /** Morph factor: 0 the globe, 1 the flat map. */
  get morph(): number {
    return this.factors[0] ?? 0;
  }

  /** Relief factor: heights are multiplied by it on both endpoints. */
  get relief(): number {
    return this.factors[1] ?? 1;
  }

  /** 1 / k(φ_anchor): plane meters per Mercator meter, so the map is true to scale at the anchor. */
  get sigma(): number {
    return this.factors[2] ?? 1;
  }
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
    this.factors[0] = factors[0] ?? 0;
    this.factors[1] = factors[1] ?? 1;
    scratch[0] = this.anchor[0];
    scratch[1] = this.anchor[1];
    scratch[2] = 0;
    geodeticArrayToEcef(scratch, this.anchorEcef);
    enuFrameAtArray(this.anchor, this.axes);
    cappedMercatorInto(this.anchor, this.anchorMercator);
    scale[0] = this.anchor[1];
    inverseScaleInto(scale);
    this.factors[2] = scale[1] ?? 1;
  }

  /**
   * Writes the plane endpoint of a vertex at Mercator `mercator[0..1]` (meters) with scaled height `mercator[2]`
   * (h·k(φ), meters) into `out[0..2]`, ECEF: E(a) + R_Aᵀ·σ·(wrap(x − x_a), y − y_a, r·h·k).
   */
  planeEndpointInto(mercator: Float64Array, out: Float64Array): void {
    wrap[0] = mercator[0] ?? 0;
    wrap[1] = this.anchorMercator[0] ?? 0;
    wrapDeltaInto(wrap);
    delta[0] = wrap[2] ?? 0;
    delta[1] = (mercator[1] ?? 0) - (this.anchorMercator[1] ?? 0);
    delta[2] = mercator[2] ?? 0;
    this.planeFromDeltaInto(delta, out);
  }

  /**
   * {@link MorphFrame.planeEndpointInto} from Mercator offsets already relative to the anchor and unwrapped:
   * `delta[0..1]` (meters) east and north, `delta[2]` the height times k (meters, multiplied by the relief factor).
   */
  planeFromDeltaInto(delta: Float64Array, out: Float64Array): void {
    const s = this.factors[2] ?? 1;
    const east = s * (delta[0] ?? 0);
    const north = s * (delta[1] ?? 0);
    const up = s * (this.factors[1] ?? 1) * (delta[2] ?? 0);
    const axes = this.axes;
    for (let i = 0; i < 3; i++)
      out[i] = (this.anchorEcef[i] ?? 0) + east * (axes[i] ?? 0) + north * (axes[3 + i] ?? 0) + up * (axes[6 + i] ?? 0);
  }

  /**
   * The plane position (ECEF) of a tile's plane center at Mercator `center[0..1]`, placed at the world copy nearest the
   * anchor (ADR 0008: per tile, never per vertex), into `out[0..2]`. The renderer adds each vertex's own plane offset.
   */
  tilePlaneCenterInto(center: Float64Array, out: Float64Array): void {
    wrap[0] = center[0] ?? 0;
    wrap[1] = this.anchorMercator[0] ?? 0;
    wrapDeltaInto(wrap);
    delta[0] = wrap[2] ?? 0;
    delta[1] = (center[1] ?? 0) - (this.anchorMercator[1] ?? 0);
    delta[2] = 0;
    this.planeFromDeltaInto(delta, out);
  }
}

const delta = new Float64Array(3);
const wrap = new Float64Array(3);

/** Wraps the longitude in `out[0]` into [−π, π), kept out of the per-frame path (KB-033). */
function wrapLongitudeInto(out: Float64Array): void {
  const lon = out[0] ?? 0;
  out[0] = lon - TWO_PI * Math.floor((lon + PI) / TWO_PI);
}

/**
 * The inverse of {@link cappedMercatorInto}: reads x and y (meters) from `xy[0..1]` and writes the longitude
 * (wrapped into [−π, π)) and latitude (radians, at most ±π/2) to `out[0..1]`. Returns false when y lies beyond the
 * caps' end at the poles (the latitude is then clamped to ±π/2): no point of the map is there (KB-100).
 */
export function inverseCappedMercatorInto(xy: Float64Array, out: Float64Array): boolean {
  const x = xy[0] ?? 0;
  const y = xy[1] ?? 0;
  out[0] = x / A;
  // Wrapped only off [−π, π): Math.floor can be a builtin call with a boxed argument in V8's mid tier (ADR 0018).
  if (x >= PI_A || x < -PI_A) wrapLongitudeInto(out);
  // Written to the array in each branch: a double merged across branches may be boxed (ADR 0018).
  if (y > HALF_EXTENT_METERS) out[1] = LIMIT_RAD + (y - HALF_EXTENT_METERS) / CAP_SLOPE_METERS_PER_RAD;
  else if (y < -HALF_EXTENT_METERS) out[1] = -LIMIT_RAD + (y + HALF_EXTENT_METERS) / CAP_SLOPE_METERS_PER_RAD;
  else out[1] = Math.atan(Math.sinh(y / A));
  if ((out[1] ?? 0) > HALF_PI) {
    out[1] = HALF_PI;
    return false;
  }
  if ((out[1] ?? 0) < -HALF_PI) {
    out[1] = -HALF_PI;
    return false;
  }
  return true;
}

/**
 * The morphed position of a geodetic point (longitude, latitude in radians, height in meters, read from
 * `geodetic[0..2]`) for `frame`, ECEF meters into `out[0..2]`: (1 − m)·E(φ, λ, r·h) + m·P (ADR 0008). The float64
 * reference of the vertex shader, for picking, culling, collision and anchoring. Allocates nothing.
 */
export function morphPointInto(frame: MorphFrame, geodetic: Float64Array, out: Float64Array): void {
  const m = frame.factors[0] ?? 0;
  const height = geodetic[2] ?? 0;
  scratch[0] = geodetic[0] ?? 0;
  scratch[1] = geodetic[1] ?? 0;
  scratch[2] = (frame.factors[1] ?? 1) * height;
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

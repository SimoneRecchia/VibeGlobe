import { ecefArrayToGeodetic, ecefToGeodetic, geodeticArrayToEcef, type GeodeticRad } from '../geodesy/ecef.js';
import { enuFrameAtArray } from '../geodesy/enu.js';
import { WGS84 } from '../geodesy/wgs84.js';
import { perspectiveReversedInfinite, viewRotation, type PerspectiveLens } from '../math/mat4.js';
import { DEFAULT_FOV_Y_RAD } from './zoom.js';

/** The camera's controlled state (ADR 0009): a target on or above the ellipsoid, a range and an orientation. */
export interface CameraPose {
  /** Target longitude, in radians. */
  targetLongitudeRad: number;
  /** Target latitude, in radians. */
  targetLatitudeRad: number;
  /** Target height above the WGS84 ellipsoid, in meters. */
  targetHeightMeters: number;
  /** Distance from the eye to the target, in meters. */
  rangeMeters: number;
  /** Heading clockwise from north, in radians. */
  headingRad: number;
  /** Tilt from the vertical: 0 looks straight down at the target. */
  tiltRad: number;
  /** Roll about the viewing direction, in radians (0 for navigation). */
  rollRad: number;
}

const NEAR_MAX_METERS = 0.1;
const NEAR_MIN_METERS = 0.001;
const A = WGS84.semiMajorAxisMeters;
const B = WGS84.semiMinorAxisMeters;

const enu = new Float64Array(9);
const horizontal = new Float64Array(3);
const scratchUp = new Float64Array(3);
const target = new Float64Array(3);
/** The two scalars of a frustum plane: the tangent of the half angle and the offset. */
const planeScalars = new Float64Array(2);

/**
 * A float64 camera (ADR 0004, ADR 0005): every derived quantity is recomputed by {@link Camera.update} into
 * preallocated arrays, so per-frame use allocates nothing. World space for the GPU is eye-relative ECEF: the eye is the
 * origin and {@link Camera.view} is a rotation. Doubles reach the functions it calls through arrays and objects, never
 * as arguments, which V8 boxes (ADR 0018).
 */
export class Camera {
  /** The controlled state; call {@link Camera.update} after changing it. */
  readonly pose: CameraPose = {
    targetLongitudeRad: 0,
    targetLatitudeRad: 0,
    targetHeightMeters: 0,
    rangeMeters: 2e7,
    headingRad: 0,
    tiltRad: 0,
    rollRad: 0,
  };
  /** Vertical field of view, in radians. */
  fovYRad = DEFAULT_FOV_Y_RAD;
  /** Viewport size in CSS pixels. */
  widthPx = 1;
  /** Viewport size in CSS pixels. */
  heightPx = 1;

  /** Eye position, ECEF meters. */
  readonly eyeEcef = new Float64Array(3);
  /** Target position, ECEF meters. */
  readonly targetEcef = new Float64Array(3);
  /** Unit viewing direction, ECEF. */
  readonly forward = new Float64Array(3);
  /** Unit screen-right axis, ECEF. */
  readonly right = new Float64Array(3);
  /** Unit screen-up axis, ECEF. */
  readonly up = new Float64Array(3);
  /** Rotation-only view matrix (eye-relative ECEF → view), column-major. */
  readonly view = new Float64Array(16);
  /** Reversed-Z infinite projection, column-major. */
  readonly projection = new Float64Array(16);
  /**
   * Frustum planes in eye-relative ECEF as (nx, ny, nz, d) with inside n·p + d ≥ 0: left, right, bottom, top, near.
   * There is no far plane (ADR 0005).
   */
  readonly frustumPlanes = new Float64Array(20);
  /** Near plane distance, in meters: min(0.1 m, half the clearance above the ellipsoid), at least 1 mm (ADR 0005). */
  nearMeters = NEAR_MAX_METERS;
  /** Eye position, geodetic. */
  readonly eyeGeodetic: GeodeticRad = { longitudeRad: 0, latitudeRad: 0, heightMeters: 0 };
  private readonly lens: PerspectiveLens = { fovYRad: DEFAULT_FOV_Y_RAD, aspect: 1, nearMeters: NEAR_MAX_METERS };

  /** Recomputes the eye, axes, matrices and frustum from the pose and viewport. */
  update(): void {
    const { pose } = this;
    target[0] = pose.targetLongitudeRad;
    target[1] = pose.targetLatitudeRad;
    target[2] = pose.targetHeightMeters;
    enuFrameAtArray(target, enu);
    geodeticArrayToEcef(target, this.targetEcef);
    const sinH = Math.sin(pose.headingRad);
    const cosH = Math.cos(pose.headingRad);
    const sinT = Math.sin(pose.tiltRad);
    const cosT = Math.cos(pose.tiltRad);
    for (let i = 0; i < 3; i++) {
      horizontal[i] = sinH * (enu[i] ?? 0) + cosH * (enu[3 + i] ?? 0);
      const upAxis = enu[6 + i] ?? 0;
      this.forward[i] = sinT * (horizontal[i] ?? 0) - cosT * upAxis;
      scratchUp[i] = cosT * (horizontal[i] ?? 0) + sinT * upAxis;
      this.eyeEcef[i] = (this.targetEcef[i] ?? 0) - pose.rangeMeters * (this.forward[i] ?? 0);
    }
    this.orientAxes();
    ecefArrayToGeodetic(this.eyeEcef, this.eyeGeodetic);
    // Comparisons, not Math.min and Math.max: code not yet fully optimized calls those with boxed doubles (ADR 0018).
    const halfClearance = 0.5 * this.eyeGeodetic.heightMeters;
    this.nearMeters =
      halfClearance > NEAR_MAX_METERS
        ? NEAR_MAX_METERS
        : halfClearance > NEAR_MIN_METERS
          ? halfClearance
          : NEAR_MIN_METERS;
    viewRotation(this.view, this.right, this.up, this.forward);
    this.lens.fovYRad = this.fovYRad;
    this.lens.aspect = this.widthPx / this.heightPx;
    this.lens.nearMeters = this.nearMeters;
    perspectiveReversedInfinite(this.projection, this.lens);
    this.updateFrustum();
  }

  /** Writes the unit direction of the ray through a CSS pixel (origin top-left) into `out`, in ECEF. */
  rayDirection(xPx: number, yPx: number, out: Float64Array): Float64Array {
    const tanV = Math.tan(this.fovYRad / 2);
    const tanH = tanV * (this.widthPx / this.heightPx);
    const ndcX = (2 * xPx) / this.widthPx - 1;
    const ndcY = 1 - (2 * yPx) / this.heightPx;
    let lengthSquared = 0;
    for (let i = 0; i < 3; i++) {
      const value = (this.forward[i] ?? 0) + ndcX * tanH * (this.right[i] ?? 0) + ndcY * tanV * (this.up[i] ?? 0);
      out[i] = value;
      lengthSquared += value * value;
    }
    const inverseLength = 1 / Math.sqrt(lengthSquared);
    for (let i = 0; i < 3; i++) out[i] = (out[i] ?? 0) * inverseLength;
    return out;
  }

  /**
   * Intersects the ray through a CSS pixel with the WGS84 ellipsoid. Writes the nearest hit to `out` and returns true,
   * or returns false when the ray misses the globe.
   */
  pickEllipsoid(xPx: number, yPx: number, out: GeodeticRad): boolean {
    this.rayDirection(xPx, yPx, rayScratch);
    const distance = rayEllipsoidDistance(this.eyeEcef, rayScratch);
    if (distance === undefined) return false;
    const x = (this.eyeEcef[0] ?? 0) + distance * (rayScratch[0] ?? 0);
    const y = (this.eyeEcef[1] ?? 0) + distance * (rayScratch[1] ?? 0);
    const z = (this.eyeEcef[2] ?? 0) + distance * (rayScratch[2] ?? 0);
    ecefToGeodetic(x, y, z, out);
    out.heightMeters = 0;
    return true;
  }

  private orientAxes(): void {
    const cosR = Math.cos(this.pose.rollRad);
    const sinR = Math.sin(this.pose.rollRad);
    const f = this.forward;
    for (let i = 0; i < 3; i++) {
      const j = (i + 1) % 3;
      const k = (i + 2) % 3;
      // right0 = forward × up0, then both rotate by the roll about forward.
      const right0 = (f[j] ?? 0) * (scratchUp[k] ?? 0) - (f[k] ?? 0) * (scratchUp[j] ?? 0);
      this.right[i] = cosR * right0 - sinR * (scratchUp[i] ?? 0);
      this.up[i] = sinR * right0 + cosR * (scratchUp[i] ?? 0);
    }
  }

  private updateFrustum(): void {
    const tanV = Math.tan(this.fovYRad / 2);
    const tanH = tanV * (this.widthPx / this.heightPx);
    const planes = this.frustumPlanes;
    planeScalars[0] = tanH;
    planeScalars[1] = 0;
    writePlane(planes, 0, this.right, 1, this.forward);
    writePlane(planes, 1, this.right, -1, this.forward);
    planeScalars[0] = tanV;
    writePlane(planes, 2, this.up, 1, this.forward);
    writePlane(planes, 3, this.up, -1, this.forward);
    planeScalars[0] = 0;
    planeScalars[1] = -this.nearMeters;
    writePlane(planes, 4, this.forward, 1, this.forward);
  }
}

const rayScratch = new Float64Array(3);

/**
 * Writes the normalized plane n = sign·axis + tan·forward, d = offset, at index `plane`, with tan and offset read from
 * `planeScalars`.
 */
function writePlane(
  planes: Float64Array,
  plane: number,
  axis: Float64Array,
  sign: number,
  forward: Float64Array,
): void {
  const tan = planeScalars[0] ?? 0;
  let lengthSquared = 0;
  for (let i = 0; i < 3; i++) {
    const value = sign * (axis[i] ?? 0) + (tan === 0 ? 0 : tan * (forward[i] ?? 0));
    planes[plane * 4 + i] = value;
    lengthSquared += value * value;
  }
  const inverseLength = 1 / Math.sqrt(lengthSquared);
  for (let i = 0; i < 3; i++) planes[plane * 4 + i] = (planes[plane * 4 + i] ?? 0) * inverseLength;
  planes[plane * 4 + 3] = planeScalars[1] ?? 0;
}

/**
 * Distance along a unit ray from `origin` (ECEF) to the nearest intersection with the WGS84 ellipsoid in front of it,
 * or undefined when the ray misses. Solved in the frame scaled by the semi-axes, where the ellipsoid is the unit sphere.
 */
export function rayEllipsoidDistance(origin: Float64Array, direction: Float64Array): number | undefined {
  const ox = (origin[0] ?? 0) / A;
  const oy = (origin[1] ?? 0) / A;
  const oz = (origin[2] ?? 0) / B;
  const dx = (direction[0] ?? 0) / A;
  const dy = (direction[1] ?? 0) / A;
  const dz = (direction[2] ?? 0) / B;
  const a = dx * dx + dy * dy + dz * dz;
  const halfB = ox * dx + oy * dy + oz * dz;
  const c = ox * ox + oy * oy + oz * oz - 1;
  const discriminant = halfB * halfB - a * c;
  if (discriminant < 0) return undefined;
  const root = Math.sqrt(discriminant);
  // Numerically stable roots: q = -(halfB + sign(halfB)·root); t1 = q / a, t2 = c / q.
  const q = -(halfB + (halfB >= 0 ? root : -root));
  const t1 = q / a;
  const t2 = q === 0 ? t1 : c / q;
  const near = Math.min(t1, t2);
  const far = Math.max(t1, t2);
  if (near >= 0) return near;
  return far >= 0 ? far : undefined;
}

/**
 * Where a tileset is drawn in a frame (F464, F465; ADR 0141). The renderer's world space is relative to the eye
 * (ADR 0004) and, during the globe-to-flat morph, morphed (ADR 0008). A tileset is placed rigidly: its ECEF geometry is
 * carried by the rotation that turns the east, north and up axes of its anchor (the root's center) into the axes the
 * frame draws there, and translated to where the frame draws the anchor. On the globe this is exactly ECEF minus the
 * eye; on the flat map a city keeps its shape (its curvature is a few centimeters over a kilometer). The inverse gives
 * traversal its camera in the tileset's ECEF, so levels of detail follow the true distances in every phase.
 */
import { ecefToGeodetic, enuFrame, morphPointInto, type FrameView, type GeodeticRad } from '@vibeglobe/core';
import type { TraversalCamera } from './traversal.js';
import type { Mat4, Plane } from './volumes.js';

/** The rigid ECEF-to-world transform of a frame: `world = rotation · (ecef − anchor) + offset`. */
export interface ViewFrame {
  /** Row-major 3×3. */
  readonly rotation: Float64Array;
  readonly anchorEcef: Float64Array;
  /** Where the frame draws the anchor, relative to the eye. */
  readonly offset: Float64Array;
}

/** The anchor of a tileset, fixed once: its geodetic position and its local east, north and up axes in ECEF. */
export class TilesetAnchor {
  readonly ecef: Float64Array;
  readonly geodetic = new Float64Array(3);
  /** Columns east, north, up (as `enuFrame`). */
  readonly enu = new Float64Array(9);

  constructor(center: readonly number[]) {
    this.ecef = Float64Array.from([center[0] ?? 0, center[1] ?? 0, center[2] ?? 0]);
    const g: GeodeticRad = { longitudeRad: 0, latitudeRad: 0, heightMeters: 0 };
    // The ECEF origin (a degenerate center) has no geodetic position: fall back to a point on the equator.
    if (Math.hypot(...this.ecef) > 1) ecefToGeodetic(this.ecef[0] ?? 0, this.ecef[1] ?? 0, this.ecef[2] ?? 0, g);
    this.geodetic.set([g.longitudeRad, g.latitudeRad, g.heightMeters]);
    enuFrame(g.longitudeRad, g.latitudeRad, this.enu);
  }
}

const morphed = new Float64Array(3);

/** Writes the frame's ECEF-to-world transform for a tileset anchored at `anchor`. */
export function viewFrame(view: FrameView, anchor: TilesetAnchor, out: ViewFrame): ViewFrame {
  const morph = view.morph;
  const flat = (morph.factors[0] ?? 0) >= 0.5;
  const axes = flat ? morph.axes : anchor.enu;
  const enu = anchor.enu;
  // rotation = axes · enuᵀ: the anchor's local axes onto the drawn ones (identity on the globe).
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (let k = 0; k < 3; k++) sum += (axes[k * 3 + r] ?? 0) * (enu[k * 3 + c] ?? 0);
      out.rotation[r * 3 + c] = flat ? sum : r === c ? 1 : 0;
    }
  if ((morph.factors[0] ?? 0) === 0) morphed.set(anchor.ecef);
  else morphPointInto(morph, anchor.geodetic, morphed);
  for (let i = 0; i < 3; i++) out.offset[i] = (morphed[i] ?? 0) - (view.eyeEcef[i] ?? 0);
  out.anchorEcef.set(anchor.ecef);
  return out;
}

/** A new, empty {@link ViewFrame}. */
export function createViewFrame(): ViewFrame {
  return { rotation: new Float64Array(9), anchorEcef: new Float64Array(3), offset: new Float64Array(3) };
}

/** Writes `frame · tileMatrix` (a column-major content-to-ECEF matrix) as a content-to-world matrix into `out`. */
export function contentToWorld(frame: ViewFrame, tileMatrix: Mat4, out: Float64Array): Float64Array {
  const R = frame.rotation;
  for (let c = 0; c < 4; c++) {
    const x = tileMatrix[c * 4] ?? 0;
    const y = tileMatrix[c * 4 + 1] ?? 0;
    const z = tileMatrix[c * 4 + 2] ?? 0;
    const w = tileMatrix[c * 4 + 3] ?? 0;
    // Columns 0–2 are directions; column 3 a point, made relative to the anchor before the rotation (precision).
    const px = c === 3 ? x - (frame.anchorEcef[0] ?? 0) * w : x;
    const py = c === 3 ? y - (frame.anchorEcef[1] ?? 0) * w : y;
    const pz = c === 3 ? z - (frame.anchorEcef[2] ?? 0) * w : z;
    for (let r = 0; r < 3; r++)
      out[c * 4 + r] =
        (R[r * 3] ?? 0) * px +
        (R[r * 3 + 1] ?? 0) * py +
        (R[r * 3 + 2] ?? 0) * pz +
        (c === 3 ? (frame.offset[r] ?? 0) : 0);
    out[c * 4 + 3] = w;
  }
  return out;
}

/** A world point (relative to the eye) back in ECEF. */
export function worldToEcef(frame: ViewFrame, world: readonly number[]): [number, number, number] {
  const d = [0, 1, 2].map((i) => (world[i] ?? 0) - (frame.offset[i] ?? 0));
  const R = frame.rotation;
  return [0, 1, 2].map(
    (c) =>
      (frame.anchorEcef[c] ?? 0) +
      (R[c] ?? 0) * (d[0] ?? 0) +
      (R[3 + c] ?? 0) * (d[1] ?? 0) +
      (R[6 + c] ?? 0) * (d[2] ?? 0),
  ) as [number, number, number];
}

/** A world direction back in ECEF axes. */
function worldDirectionToEcef(frame: ViewFrame, d: readonly number[]): [number, number, number] {
  const R = frame.rotation;
  return [0, 1, 2].map(
    (c) => (R[c] ?? 0) * (d[0] ?? 0) + (R[3 + c] ?? 0) * (d[1] ?? 0) + (R[6 + c] ?? 0) * (d[2] ?? 0),
  ) as [number, number, number];
}

/** `a · b` for column-major 4×4 matrices. */
function multiply4(a: ArrayLike<number>, b: ArrayLike<number>): Float64Array {
  const out = new Float64Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += (a[k * 4 + r] ?? 0) * (b[c * 4 + k] ?? 0);
      out[c * 4 + r] = sum;
    }
  return out;
}

/**
 * The traversal camera of a frame in the tileset's ECEF: the eye, the view direction, the four side planes of the
 * frustum (the engine's projection is infinite, ADR 0005, so there is no far plane; tiles behind the eye fail the side
 * planes' combination only partly, which costs a little extra loading and never a hole), the viewport height in CSS
 * pixels and the vertical field of view.
 */
export function traversalCamera(view: FrameView, frame: ViewFrame): TraversalCamera {
  const v = view.view;
  // The view is rotation-only (the eye at the world origin): its third row is the camera's +Z, the view looks along −Z.
  const forward = [-(v[2] ?? 0), -(v[6] ?? 0), -(v[10] ?? 0)];
  // world = R·(ecef − anchor) + offset, as a column-major 4×4.
  const R = frame.rotation;
  const toWorld = new Float64Array(16);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) toWorld[c * 4 + r] = R[r * 3 + c] ?? 0;
    let t = frame.offset[r] ?? 0;
    for (let c = 0; c < 3; c++) t -= (R[r * 3 + c] ?? 0) * (frame.anchorEcef[c] ?? 0);
    toWorld[12 + r] = t;
  }
  toWorld[15] = 1;
  const clip = multiply4(view.projection, multiply4(view.view, toWorld));
  const row = (i: number): number[] => [clip[i] ?? 0, clip[4 + i] ?? 0, clip[8 + i] ?? 0, clip[12 + i] ?? 0];
  const w = row(3);
  const planes: Plane[] = [];
  for (const [i, sign] of [
    [0, 1],
    [0, -1],
    [1, 1],
    [1, -1],
  ] as const) {
    const p = row(i).map((value, k) => (w[k] ?? 0) + sign * value);
    const n = Math.hypot(p[0] ?? 0, p[1] ?? 0, p[2] ?? 0);
    if (n > 0) planes.push([(p[0] ?? 0) / n, (p[1] ?? 0) / n, (p[2] ?? 0) / n, (p[3] ?? 0) / n]);
  }
  const p5 = view.projection[5] ?? 1;
  return {
    position: worldToEcef(frame, [0, 0, 0]),
    direction: worldDirectionToEcef(frame, forward),
    planes,
    viewportHeightPx: view.heightPx,
    fovYRad: 2 * Math.atan(1 / p5),
  };
}

/** The world-space ray through a canvas point (CSS pixels from the top left): origin at the eye, unit direction. */
export function screenRay(view: FrameView, xPx: number, yPx: number): { origin: number[]; direction: number[] } {
  const ndcX = (2 * xPx) / view.widthPx - 1;
  const ndcY = 1 - (2 * yPx) / view.heightPx;
  const p = view.projection;
  // Camera-space direction for a perspective projection: x / −z = ndcX / p0 (with p8 skew), likewise y.
  const cx = (ndcX + (p[8] ?? 0)) / (p[0] ?? 1);
  const cy = (ndcY + (p[9] ?? 0)) / (p[5] ?? 1);
  const v = view.view;
  // Camera to world: the transpose of the view's rotation.
  const d = [0, 1, 2].map((i) => (v[i * 4] ?? 0) * cx + (v[i * 4 + 1] ?? 0) * cy - (v[i * 4 + 2] ?? 0));
  const n = Math.hypot(...d);
  return { origin: [0, 0, 0], direction: d.map((c) => c / n) };
}

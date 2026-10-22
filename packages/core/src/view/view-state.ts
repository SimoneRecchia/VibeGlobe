import type { Camera } from '../camera/camera.js';
import { WGS84 } from '../geodesy/wgs84.js';
import { GlobeError } from '../globe/errors.js';
import { CURVE_MORPH, CURVE_RELIEF, evaluateViewCurves, smootherstepInto, type ViewCurves } from './curves.js';
import { MorphFrame } from './morph.js';
import { skyTiltLimitRad, terrainTiltLimitRad } from './tilt-limits.js';

/** Applied tilt over which relief reaches full height whatever the zoom (ADR 0029), radians: 0° to 30°. */
const RELIEF_TILT_RAD = (30 * Math.PI) / 180;
/** The equator's length over 512 px: ground meters per pixel at ground zoom 0 (`groundZoomForRange`). */
const METERS_PER_PIXEL_AT_ZERO = (2 * Math.PI * WGS84.semiMajorAxisMeters) / 512;

const groundZoom = new Float64Array(1);
const curveValues = new Float64Array(3);
const anchor = new Float64Array(2);
const factors = new Float64Array(2);
const tiltStep = new Float64Array(4);
const limits = new Float64Array(8);

/** The view modes (`PLAN.md`, Map experience): the zoom curves drive the tilt, it stays 0°, or the user chose it. */
export type ViewMode = 'auto' | '2d' | 'manual';

/** The phase a frame shows (`PLAN.md`, Map experience table). */
export type ViewPhase = 'globe' | 'flattening' | '2d' | '3d';

/**
 * Each frame an offset from a target keeps this share of itself (F150, F162, F163, F165, F166): a mode change, a
 * released clamp or new curves ease over a few frames instead of jumping. Offsets below the floors end at once.
 */
const OFFSET_KEPT = 0.75;
const MIN_TILT_OFFSET_RAD = (0.05 * Math.PI) / 180;
const MIN_FACTOR_OFFSET = 1e-4;

/** Slots of {@link ViewState}'s values: doubles in an array, as a double field may be boxed (ADR 0018). */
const GROUND_ZOOM = 0;
const AUTO_TILT = 1;
const APPLIED_TILT = 2;
/** Applied minus target tilt, and applied minus curve morph and relief, each decaying to 0. */
const TILT_OFFSET = 3;
const MORPH_OFFSET = 4;
const RELIEF_OFFSET = 5;
/** The tilt each mode aims at this frame, before limits. */
const TARGET_TILT = 6;

/**
 * The zoom-driven state of one frame (ADR 0008, ADR 0029): the ground zoom at the screen center, the Auto curves'
 * values there, the view mode with the user's chosen tilt, and the morph frame anchored at the camera target. Relief
 * follows its zoom curve, or the applied tilt when that asks for more (a view tilted by hand shows its relief at every
 * zoom). Allocates nothing per frame.
 */
export class ViewState {
  /** The morph of the frame. */
  readonly morph = new MorphFrame();
  private readonly values = new Float64Array(7);
  /** The user's chosen tilt, radians: kept apart from the applied one, which clamps never write here (F164). */
  private readonly chosen = new Float64Array(1);
  /** True when the next frame applies the target tilt at once (a camera cut), not eased. */
  private snap = true;
  /** The current mode; `manual` holds the chosen tilt at every zoom. */
  mode: ViewMode = 'auto';

  constructor(public curves: ViewCurves) {}

  /** Ground zoom at the screen center. */
  get groundZoom(): number {
    return this.values[GROUND_ZOOM] ?? 0;
  }

  /** The automatic tilt the Auto curves give at this zoom, radians. */
  get autoTiltRad(): number {
    return this.values[AUTO_TILT] ?? 0;
  }

  /** The tilt the user chose, radians: what manual mode shows wherever no clamp applies. */
  get chosenTiltRad(): number {
    return this.chosen[0] ?? 0;
  }

  /** The phase the last frame showed: from the morph factor, then the tilt band of the curves. */
  get phase(): ViewPhase {
    const m = this.morph.factors[0] ?? 0;
    if (m <= 0) return 'globe';
    if (m < 1) return 'flattening';
    return (this.values[GROUND_ZOOM] ?? 0) < this.curves.tilt.startGroundZoom ? '2d' : '3d';
  }

  /**
   * The 2D / 3D / Auto toggle (F163): 2D locks the tilt at 0°, 3D chooses the automatic tilt as a manual tilt, Auto
   * restores the zoom curves. The applied tilt eases to the new target. Any other mode throws a GlobeError.
   */
  setMode(mode: '2d' | '3d' | 'auto'): void {
    if (mode !== '2d' && mode !== '3d' && mode !== 'auto')
      throw new GlobeError('invalid-option', `A view mode is '2d', '3d' or 'auto', got ${String(mode)}`);
    if (mode === '3d') {
      this.mode = 'manual';
      this.chosen[0] = (this.curves.autoTiltDeg * Math.PI) / 180;
    } else this.mode = mode;
    this.easeTiltFromApplied();
  }

  /** A tilt chosen by the user or a view (radians): manual mode, applied at once (ADR 0029). */
  chooseTilt(tiltRad: number): void {
    this.mode = 'manual';
    this.chosen[0] = tiltRad;
    this.snap = true;
  }

  /**
   * Replaces the zoom curves at runtime (F150): the morph, relief and tilt ease from what the last frame showed to
   * the new curves' values instead of jumping.
   */
  setCurves(curves: ViewCurves): void {
    const shownMorph = this.morph.factors[0] ?? 0;
    const shownRelief = this.morph.factors[1] ?? 0;
    this.curves = curves;
    groundZoom[0] = this.values[GROUND_ZOOM] ?? 0;
    evaluateViewCurves(curves, groundZoom, curveValues);
    this.values[AUTO_TILT] = curveValues[2] ?? 0;
    this.values[MORPH_OFFSET] = shownMorph - (curveValues[CURVE_MORPH] ?? 0);
    this.values[RELIEF_OFFSET] = shownRelief - (curveValues[CURVE_RELIEF] ?? 0);
    this.easeTiltFromApplied();
  }

  /**
   * Sets the camera's applied tilt for this frame (F161–F166): the mode's target (the Auto curve, 0° in 2D, the chosen
   * tilt in manual mode) plus the decaying offset of a recent change, clamped where the camera would enter the terrain
   * (`clearanceMeters` above the surface under the eye; 0 without terrain) or where empty sky would fill more than the
   * top third of the screen. A limit applies at once; a released one eases back. Updates the camera. Call once per
   * frame; allocates nothing.
   */
  applyTilt(camera: Camera, clearanceMeters: number): void {
    this.computeCurves(camera);
    const values = this.values;
    this.computeTarget();
    const target = values[TARGET_TILT] ?? 0;
    if (this.snap) values[TILT_OFFSET] = 0;
    decay(values, TILT_OFFSET, MIN_TILT_OFFSET_RAD);
    decay(values, MORPH_OFFSET, MIN_FACTOR_OFFSET);
    decay(values, RELIEF_OFFSET, MIN_FACTOR_OFFSET);
    this.snap = false;
    limits[0] = camera.pose.rangeMeters;
    limits[1] = camera.pose.targetHeightMeters;
    limits[2] = camera.fovYRad;
    limits[3] = this.morph.factors[0] ?? 0;
    limits[4] = camera.groundHeightMeters;
    limits[5] = clearanceMeters;
    skyTiltLimitRad(limits);
    if (clearanceMeters > 0) {
      terrainTiltLimitRad(limits);
      if ((limits[7] ?? 0) < (limits[6] ?? 0)) limits[6] = limits[7] ?? 0;
    }
    const allowed = limits[6] ?? 0;
    // The applied tilt: the target and its offset, below the limit; a limit leaves an offset that eases back.
    values[APPLIED_TILT] = target + (values[TILT_OFFSET] ?? 0);
    if ((values[APPLIED_TILT] ?? 0) < 0) values[APPLIED_TILT] = 0;
    if ((values[APPLIED_TILT] ?? 0) > allowed) {
      values[APPLIED_TILT] = allowed;
      values[TILT_OFFSET] = allowed - target;
    }
    camera.pose.tiltRad = values[APPLIED_TILT] ?? 0;
    camera.update();
  }

  /** Recomputes the state from the camera's pose and viewport (after {@link Camera.update}). */
  update(camera: Camera): void {
    this.computeCurves(camera);
    tiltStep[0] = 0;
    tiltStep[1] = RELIEF_TILT_RAD;
    tiltStep[2] = camera.pose.tiltRad;
    smootherstepInto(tiltStep);
    const zoomRelief = (curveValues[CURVE_RELIEF] ?? 0) + (this.values[RELIEF_OFFSET] ?? 0);
    const tiltRelief = tiltStep[3] ?? 0;
    anchor[0] = camera.pose.targetLongitudeRad;
    anchor[1] = camera.pose.targetLatitudeRad;
    factors[0] = (curveValues[CURVE_MORPH] ?? 0) + (this.values[MORPH_OFFSET] ?? 0);
    factors[1] = zoomRelief > tiltRelief ? zoomRelief : tiltRelief;
    for (let i = 0; i < 2; i++) {
      if ((factors[i] ?? 0) < 0) factors[i] = 0;
      if ((factors[i] ?? 0) > 1) factors[i] = 1;
    }
    this.morph.update(anchor, factors);
  }

  /** The tilt the mode aims at, into `values[TARGET_TILT]`. */
  private computeTarget(): void {
    const values = this.values;
    if (this.mode === '2d') values[TARGET_TILT] = 0;
    else if (this.mode === 'auto') values[TARGET_TILT] = values[AUTO_TILT] ?? 0;
    else values[TARGET_TILT] = this.chosen[0] ?? 0;
  }

  /** Starts easing from the tilt the last frame applied to the current mode's target. */
  private easeTiltFromApplied(): void {
    this.computeTarget();
    this.values[TILT_OFFSET] = (this.values[APPLIED_TILT] ?? 0) - (this.values[TARGET_TILT] ?? 0);
  }

  /** The ground zoom at the screen center and the Auto curves there, into `curveValues` and `values`. */
  private computeCurves(camera: Camera): void {
    // groundZoomForRange written out: a double returned from a call is boxed (ADR 0018).
    const metersPerPixel = (camera.pose.rangeMeters * Math.tan(camera.fovYRad / 2)) / (camera.heightPx / 2);
    groundZoom[0] = Math.log2(METERS_PER_PIXEL_AT_ZERO / metersPerPixel);
    this.values[GROUND_ZOOM] = groundZoom[0];
    evaluateViewCurves(this.curves, groundZoom, curveValues);
    this.values[AUTO_TILT] = curveValues[2] ?? 0;
    this.morph.factors[0] = (curveValues[CURVE_MORPH] ?? 0) + (this.values[MORPH_OFFSET] ?? 0);
  }
}

/** Shrinks the offset in `values[slot]` by one frame's share, ending it below `floor`. */
function decay(values: Float64Array, slot: number, floor: number): void {
  values[slot] = (values[slot] ?? 0) * OFFSET_KEPT;
  if ((values[slot] ?? 0) < floor && (values[slot] ?? 0) > -floor) values[slot] = 0;
}

import type { Camera } from '../camera/camera.js';
import { WGS84 } from '../geodesy/wgs84.js';
import { GlobeError } from '../globe/errors.js';
import { CURVE_MORPH, CURVE_RELIEF, evaluateViewCurves, smootherstepInto, type ViewCurves } from './curves.js';
import { MorphFrame } from './morph.js';
import { skyTiltLimitRad, terrainTiltLimitRad } from './tilt-limits.js';

/** Applied tilt over which relief reaches full height whatever the zoom (ADR 0034), radians: 0° to 30°. */
const RELIEF_TILT_RAD = (30 * Math.PI) / 180;
/** The equator's length over 512 px: ground meters per pixel at ground zoom 0 (`groundZoomForRange`). */
const METERS_PER_PIXEL_AT_ZERO = (2 * Math.PI * WGS84.semiMajorAxisMeters) / 512;

const groundZoom = new Float64Array(1);
const curveValues = new Float64Array(3);
const anchor = new Float64Array(2);
const factors = new Float64Array(2);
const tiltStep = new Float64Array(4);
const limits = new Float64Array(8);

/** Probes the surface under the camera's eye: sets `camera.groundHeightMeters` to the height the frame draws there. */
export interface GroundProbe {
  probeGround(camera: Camera): void;
}

/** Bisection steps of the probed terrain limit: 14 halvings of 89° leave about 0.005°. */
const PROBE_STEPS = 14;

/** The view modes (`PLAN.md`, Map experience): the zoom curves drive the tilt, it stays 0°, or the user chose it. */
export type ViewMode = 'auto' | '2d' | 'manual';

/** The phase a frame shows (`PLAN.md`, Map experience table). */
export type ViewPhase = 'globe' | 'flattening' | '2d' | '3d';

/**
 * Each frame an offset from a target keeps this share of itself (F150, F162, F163, F165, F166): a mode change, a
 * released clamp or new curves ease over a few frames instead of jumping. Offsets below the floors end at once.
 */
const OFFSET_KEPT = 0.75;
/** The frame the share is kept over (60 Hz), milliseconds: at other rates it is kept per elapsed time (KB-099). */
const OFFSET_FRAME_MS = 1000 / 60;
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
/** The target with its offset, within 0° and the sky limit: what the terrain limit may lower. */
const WANTED_TILT = 7;
/** The bracket of the probed terrain limit (KB-096). */
const LOW_TILT = 8;
const HIGH_TILT = 9;
/** The engine time of the last applied frame, and the share of an offset kept this frame (KB-099). */
const LAST_TIME = 10;
const KEPT = 11;
/** The maximum tilt of the camera constraints (F210), radians; NaN without one. */
const TILT_CAP = 12;

/**
 * The zoom-driven state of one frame (ADR 0008, ADR 0034): the ground zoom at the screen center, the Auto curves'
 * values there, the view mode with the user's chosen tilt, and the morph frame anchored at the camera target. Relief
 * follows its zoom curve, or the applied tilt when that asks for more (a view tilted by hand shows its relief at every
 * zoom). Allocates nothing per frame.
 */
export class ViewState {
  /** The morph of the frame. */
  readonly morph = new MorphFrame();
  private readonly values = Float64Array.of(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, Number.NaN);
  /** The user's chosen tilt, radians: kept apart from the applied one, which clamps never write here (F164). */
  private readonly chosen = new Float64Array(1);
  /** True when a limit lowered the last applied tilt below what the mode wanted. */
  private clamped = false;
  /** True when the next frame applies the target tilt at once (a camera cut), not eased. */
  private snap = true;
  /** The engine time of the frame being prepared, milliseconds: written by the frame loop before {@link applyTilt}. */
  readonly frameTimeMs = new Float64Array(1);
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

  /**
   * True while a tilt, morph or relief transition is still easing: the frame loop must keep drawing (KB-095). A tilt
   * held down by a limit is not easing: it changes only when the camera or the surface does.
   */
  get easing(): boolean {
    return (
      ((this.values[TILT_OFFSET] ?? 0) !== 0 && !this.clamped) ||
      (this.values[MORPH_OFFSET] ?? 0) !== 0 ||
      (this.values[RELIEF_OFFSET] ?? 0) !== 0
    );
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

  /** A tilt chosen by the user or a view (radians): manual mode, applied at once (ADR 0034). */
  chooseTilt(tiltRad: number): void {
    this.mode = 'manual';
    const cap = this.values[TILT_CAP] ?? Number.NaN;
    this.chosen[0] = cap === cap && tiltRad > cap ? cap : tiltRad;
    this.snap = true;
  }

  /** Sets the maximum tilt of the camera constraints (F210), radians, or NaN for none; a chosen tilt above it drops. */
  setMaxTilt(maxTiltRad: number): void {
    this.values[TILT_CAP] = maxTiltRad;
    if (maxTiltRad === maxTiltRad && (this.chosen[0] ?? 0) > maxTiltRad) this.chosen[0] = maxTiltRad;
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
   * top third of the screen. A limit applies at once; a released one eases back. With a `ground` probe the terrain
   * limit reads the surface under the eye at each candidate tilt (KB-096). Updates the camera. Call once per frame;
   * allocates nothing.
   */
  applyTilt(camera: Camera, clearanceMeters: number, ground?: GroundProbe): void {
    this.computeCurves(camera);
    const values = this.values;
    this.computeTarget();
    const target = values[TARGET_TILT] ?? 0;
    if (this.snap) values[TILT_OFFSET] = 0;
    // The share kept over the time since the last frame, so transitions take the same time at every frame rate.
    const elapsed = (this.frameTimeMs[0] ?? 0) - (values[LAST_TIME] ?? 0);
    values[KEPT] = elapsed > 0 && elapsed < 1000 ? OFFSET_KEPT ** (elapsed / OFFSET_FRAME_MS) : OFFSET_KEPT;
    values[LAST_TIME] = this.frameTimeMs[0] ?? 0;
    decay(values, TILT_OFFSET, MIN_TILT_OFFSET_RAD);
    decay(values, MORPH_OFFSET, MIN_FACTOR_OFFSET);
    decay(values, RELIEF_OFFSET, MIN_FACTOR_OFFSET);
    this.snap = false;
    limits[0] = camera.pose.rangeMeters;
    limits[1] = camera.pose.targetHeightMeters;
    limits[2] = camera.fovYRad;
    limits[3] = this.morph.factors[0] ?? 0;
    limits[5] = clearanceMeters;
    skyTiltLimitRad(limits);
    // The tilt the mode wants, at least 0° and at most the sky limit.
    values[WANTED_TILT] = target + (values[TILT_OFFSET] ?? 0);
    if ((values[WANTED_TILT] ?? 0) < 0) values[WANTED_TILT] = 0;
    if ((values[WANTED_TILT] ?? 0) > (limits[6] ?? 0)) values[WANTED_TILT] = limits[6] ?? 0;
    if ((values[WANTED_TILT] ?? 0) > (values[TILT_CAP] ?? Number.NaN)) values[WANTED_TILT] = values[TILT_CAP] ?? 0;
    values[APPLIED_TILT] = values[WANTED_TILT] ?? 0;
    if (clearanceMeters > 0 && ground) this.probeTerrainLimit(camera, ground);
    else if (clearanceMeters > 0) {
      limits[4] = camera.groundHeightMeters;
      terrainTiltLimitRad(limits);
      if ((values[APPLIED_TILT] ?? 0) > (limits[7] ?? 0)) values[APPLIED_TILT] = limits[7] ?? 0;
    }
    // A limit leaves an offset that eases back; while it holds, the tilt is not easing (KB-095).
    this.clamped = (values[APPLIED_TILT] ?? 0) < target + (values[TILT_OFFSET] ?? 0);
    if ((values[APPLIED_TILT] ?? 0) < target + (values[TILT_OFFSET] ?? 0))
      values[TILT_OFFSET] = (values[APPLIED_TILT] ?? 0) - target;
    camera.pose.tiltRad = values[APPLIED_TILT] ?? 0;
    camera.update();
  }

  /**
   * The terrain limit with the surface probed under the eye (KB-096): the ground there moves with the tilt, so the
   * wanted tilt stands when its eye clears the surface; otherwise a bisection finds the steepest tilt below it whose
   * eye does, probing at each step. Writes `values[APPLIED_TILT]`; leaves the camera's ground probed at the result.
   */
  private probeTerrainLimit(camera: Camera, ground: GroundProbe): void {
    const values = this.values;
    if (clears(camera, values, WANTED_TILT, ground)) return;
    values[LOW_TILT] = 0;
    values[HIGH_TILT] = values[WANTED_TILT] ?? 0;
    for (let step = 0; step < PROBE_STEPS; step++) {
      values[APPLIED_TILT] = ((values[LOW_TILT] ?? 0) + (values[HIGH_TILT] ?? 0)) / 2;
      if (clears(camera, values, APPLIED_TILT, ground)) values[LOW_TILT] = values[APPLIED_TILT] ?? 0;
      else values[HIGH_TILT] = values[APPLIED_TILT] ?? 0;
    }
    values[APPLIED_TILT] = values[LOW_TILT] ?? 0;
    clears(camera, values, APPLIED_TILT, ground);
  }

  /**
   * Sets the camera's tilt to what the next frame will apply at its current range, before an input solves for a point
   * under the cursor (KB-098): the mode's target with the running offset, at most the sky limit. Changes no state.
   */
  previewTilt(camera: Camera): void {
    this.computeCurves(camera);
    this.computeTarget();
    const values = this.values;
    limits[0] = camera.pose.rangeMeters;
    limits[1] = camera.pose.targetHeightMeters;
    limits[2] = camera.fovYRad;
    limits[3] = this.morph.factors[0] ?? 0;
    skyTiltLimitRad(limits);
    values[WANTED_TILT] = (values[TARGET_TILT] ?? 0) + (values[TILT_OFFSET] ?? 0);
    if ((values[WANTED_TILT] ?? 0) < 0) values[WANTED_TILT] = 0;
    if ((values[WANTED_TILT] ?? 0) > (limits[6] ?? 0)) values[WANTED_TILT] = limits[6] ?? 0;
    if ((values[WANTED_TILT] ?? 0) > (values[TILT_CAP] ?? Number.NaN)) values[WANTED_TILT] = values[TILT_CAP] ?? 0;
    // Never above the tilt the camera has: a terrain clamp holding it lower stays.
    if ((values[WANTED_TILT] ?? 0) > camera.pose.tiltRad && this.clamped) return;
    camera.pose.tiltRad = values[WANTED_TILT] ?? 0;
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

/**
 * True when, at the tilt in `values[slot]` (radians), the eye stands at least the clearance (`limits[5]`) above the
 * surface probed under it; leaves the camera at that tilt with its ground probed. Doubles stay in arrays (ADR 0018).
 */
function clears(camera: Camera, values: Float64Array, slot: number, ground: GroundProbe): boolean {
  camera.pose.tiltRad = values[slot] ?? 0;
  camera.update();
  ground.probeGround(camera);
  return camera.eyeGeodetic.heightMeters - camera.groundHeightMeters >= (limits[5] ?? 0);
}

/** Shrinks the offset in `values[slot]` by one frame's share, ending it below `floor`. */
function decay(values: Float64Array, slot: number, floor: number): void {
  values[slot] = (values[slot] ?? 0) * (values[KEPT] ?? OFFSET_KEPT);
  if ((values[slot] ?? 0) < floor && (values[slot] ?? 0) > -floor) values[slot] = 0;
}

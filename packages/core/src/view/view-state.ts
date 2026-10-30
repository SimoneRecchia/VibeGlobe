// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { Camera } from '../camera/camera.js';
import { WGS84 } from '../geodesy/wgs84.js';
import { GlobeError } from '../globe/errors.js';
import { WEB_MERCATOR_MAX_LATITUDE_RAD } from '../projections/web-mercator.js';
import { CURVE_MORPH, CURVE_RELIEF, evaluateViewCurves, smootherstepInto, type ViewCurves } from './curves.js';
import { MorphFrame } from './morph.js';
import { skyTiltLimitRad, terrainTiltLimitRad } from './tilt-limits.js';

/** Applied tilt over which relief reaches full height whatever the zoom (ADR 0034), radians: 0° to 30°. */
const RELIEF_TILT_RAD = (30 * Math.PI) / 180;
/** The equator's length over 512 px: ground meters per pixel at ground zoom 0 (`groundZoomForRange`). */
const METERS_PER_PIXEL_AT_ZERO = (2 * Math.PI * WGS84.semiMajorAxisMeters) / 512;

/** The tilt's lengthening of the view toward the horizon is counted up to 1 / this cosine. */
const MIN_TILT_COSINE = 0.2;

const groundZoom = new Float64Array(1);
const capStep = new Float64Array(4);
const curveValues = new Float64Array(3);
const anchor = new Float64Array(2);
const factors = new Float64Array(2);
const tiltStep = new Float64Array(4);
const limits = new Float64Array(8);
const policyStep = new Float64Array(4);

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
/**
 * The most the terrain limit lowers the tilt in one frame, radians, and the relief the tilt carries (KB-170): a fast
 * descent onto a flank would drop both by a jump; the collision's lift keeps the eye its clearance above the ground
 * meanwhile (F146).
 */
const MAX_LIMIT_DROP_RAD = (4 * Math.PI) / 180;
const MAX_RELIEF_DROP = 0.06;

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
/** The tilt the previous frame applied, radians: where a limit that no tilt satisfies holds the tilt (KB-153). */
const PREVIOUS_TILT = 13;
/** The share of the curve's morph the polar caps leave (KB-211): 0 where the view reaches a cap, else 1. */
const CAP_KEEP = 14;
/** The tilt policy's cap this frame, radians (F625): 0 beyond its lock, NaN without a policy. */
const POLICY_CAP = 15;
/** 1 for the frame after the tilt policy's availability changed, so the controls see it in the next one (F625). */
const POLICY_FLIP = 16;
/** The most a limit moves the tilt this frame, radians (KB-170): see {@link writeStep}. */
const STEP = 17;

/**
 * The zoom-driven state of one frame (ADR 0008, ADR 0034): the ground zoom at the screen center, the Auto curves'
 * values there, the view mode with the user's chosen tilt, and the morph frame anchored at the camera target. Relief
 * follows its zoom curve, or the applied tilt when that asks for more (a view tilted by hand shows its relief at every
 * zoom). Allocates nothing per frame.
 */
export class ViewState {
  /** The morph of the frame. */
  readonly morph = new MorphFrame();
  private readonly values = Float64Array.of(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, Number.NaN, 0, 1, Number.NaN, 0, 0);
  /**
   * The tilt policy the controls set (F625, `NavigationApi.tiltPolicy`): `[0]` the distance from the eye to the point
   * looked at beyond which the view is flat, meters (0: no policy, the zoom curves' tilt), `[1]` the distance within
   * which the automatic tilt rises, reaching `[2]` (radians) at a quarter of it, `[4]` the octaves from the lock to
   * where the policy stops capping the tilt (F641; 0: one). Written each frame: `[3]` 1 while the camera may tilt, 0
   * beyond the lock, and `[5]` the largest tilt the frame allowed, radians (F642).
   */
  readonly tiltPolicy = Float64Array.of(0, 0, 0, 1, 0, 0);
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
      (this.values[RELIEF_OFFSET] ?? 0) !== 0 ||
      this.values[POLICY_FLIP] === 1
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
      // Within the maximum tilt of the constraints (F210).
      const cap = this.values[TILT_CAP] ?? Number.NaN;
      const tilt =
        (this.tiltPolicy[0] ?? 0) > 0 ? (this.tiltPolicy[2] ?? 0) : (this.curves.autoTiltDeg * Math.PI) / 180;
      // A NaN cap (none) compares false.
      this.chosen[0] = tilt > cap ? cap : tilt;
    } else this.mode = mode;
    this.easeTiltFromApplied();
  }

  /** A tilt chosen by the user or a view (radians): manual mode, applied at once (ADR 0034). */
  chooseTilt(tiltRad: number): void {
    this.mode = 'manual';
    const cap = this.values[TILT_CAP] ?? Number.NaN;
    this.chosen[0] = tiltRad > cap ? cap : tiltRad;
    this.snap = true;
  }

  /** Sets the maximum tilt of the camera constraints (F210), radians, or NaN for none; a chosen tilt above it drops. */
  setMaxTilt(maxTiltRad: number): void {
    this.values[TILT_CAP] = maxTiltRad;
    if ((this.chosen[0] ?? 0) > maxTiltRad) this.chosen[0] = maxTiltRad;
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
    curveValues[CURVE_MORPH] = (curveValues[CURVE_MORPH] ?? 0) * (this.values[CAP_KEEP] ?? 1);
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
    // Once a frame, whether the tilt policy lets the camera tilt (F625); a change keeps one more frame coming.
    const lock = this.tiltPolicy[0] ?? 0;
    const allowed = lock > 0 && camera.pose.rangeMeters > lock ? 0 : 1;
    values[POLICY_FLIP] = this.tiltPolicy[3] === allowed ? 0 : 1;
    this.tiltPolicy[3] = allowed;
    this.computeTarget();
    const target = values[TARGET_TILT] ?? 0;
    const snapped = this.snap;
    if (snapped) values[TILT_OFFSET] = 0;
    // The share kept over the time since the last frame, so transitions take the same time at every frame rate.
    const elapsed = (this.frameTimeMs[0] ?? 0) - (values[LAST_TIME] ?? 0);
    values[KEPT] = elapsed > 0 && elapsed < 1000 ? OFFSET_KEPT ** (elapsed / OFFSET_FRAME_MS) : OFFSET_KEPT;
    values[LAST_TIME] = this.frameTimeMs[0] ?? 0;
    decay(values, TILT_OFFSET, MIN_TILT_OFFSET_RAD);
    decay(values, MORPH_OFFSET, MIN_FACTOR_OFFSET);
    decay(values, RELIEF_OFFSET, MIN_FACTOR_OFFSET);
    this.snap = false;
    limits[5] = clearanceMeters;
    this.wantTilt(camera, this.tiltPolicy, 5);
    values[PREVIOUS_TILT] = values[APPLIED_TILT] ?? 0;
    values[APPLIED_TILT] = values[WANTED_TILT] ?? 0;
    writeStep(values);
    if (clearanceMeters > 0 && ground) this.probeTerrainLimit(camera, ground);
    else if (clearanceMeters > 0) {
      limits[4] = camera.groundHeightMeters;
      terrainTiltLimitRad(limits);
      if ((values[APPLIED_TILT] ?? 0) > (limits[7] ?? 0)) values[APPLIED_TILT] = limits[7] ?? 0;
    }
    // After a jump the limit applies at once; otherwise the tilt it lowers falls at most a step a frame (KB-170).
    const floor = (values[PREVIOUS_TILT] ?? 0) - (values[STEP] ?? 0);
    if (!snapped && (values[APPLIED_TILT] ?? 0) < floor) {
      values[APPLIED_TILT] = (values[WANTED_TILT] ?? 0) < floor ? (values[WANTED_TILT] ?? 0) : floor;
      if (ground) clears(this, camera, values, APPLIED_TILT, ground);
    }
    // A limit leaves an offset that eases back; while it holds, the tilt is not easing (KB-095).
    const applied = values[APPLIED_TILT] ?? 0;
    this.clamped = applied < target + (values[TILT_OFFSET] ?? 0);
    if (this.clamped) {
      values[TILT_OFFSET] = applied - target;
      // Terrain clearance holding the tilt lower is the most a tilt slider can reach now (F642).
      if (applied < (this.tiltPolicy[5] ?? 0)) this.tiltPolicy[5] = applied;
    }
    camera.pose.tiltRad = applied;
    camera.update();
  }

  /**
   * The terrain limit with the surface probed under the eye (KB-096): the ground there moves with the tilt, so the
   * wanted tilt stands when its eye clears the surface; otherwise a bisection finds the steepest tilt below it whose
   * eye does, probing at each step. Writes `values[APPLIED_TILT]`; leaves the camera's ground probed at the result.
   */
  private probeTerrainLimit(camera: Camera, ground: GroundProbe): void {
    const values = this.values;
    if (clears(this, camera, values, WANTED_TILT, ground)) return;
    values[LOW_TILT] = 0;
    // Under the terrain even looking straight down: the target is below the surface (after a jump, before the frame
    // lifts it), which no tilt mends, so the lift alone keeps the eye clear and the tilt is the wanted one (KB-104);
    // while a limit held the previous frame lower, it climbs back to it a step a frame, so a zoom that reaches this
    // point neither jumps up (KB-153) nor stays lowered (KB-170).
    if (!clears(this, camera, values, LOW_TILT, ground)) {
      const wanted = values[WANTED_TILT] ?? 0;
      values[HIGH_TILT] = (values[PREVIOUS_TILT] ?? 0) + (values[STEP] ?? 0);
      const held = this.clamped && (values[HIGH_TILT] ?? 0) < wanted;
      values[APPLIED_TILT] = held ? (values[HIGH_TILT] ?? 0) : wanted;
      clears(this, camera, values, APPLIED_TILT, ground);
      return;
    }
    values[HIGH_TILT] = values[WANTED_TILT] ?? 0;
    for (let step = 0; step < PROBE_STEPS; step++) {
      values[APPLIED_TILT] = ((values[LOW_TILT] ?? 0) + (values[HIGH_TILT] ?? 0)) / 2;
      if (clears(this, camera, values, APPLIED_TILT, ground)) values[LOW_TILT] = values[APPLIED_TILT] ?? 0;
      else values[HIGH_TILT] = values[APPLIED_TILT] ?? 0;
    }
    values[APPLIED_TILT] = values[LOW_TILT] ?? 0;
    clears(this, camera, values, APPLIED_TILT, ground);
  }

  /**
   * Sets the camera's tilt to what the next frame will apply at its current range, before an input solves for a point
   * under the cursor (KB-098): the mode's target with the running offset, at most the sky limit. Changes no state.
   */
  previewTilt(camera: Camera): void {
    this.computeCurves(camera);
    this.computeTarget();
    const values = this.values;
    // The bracket's slot is free between frames: the largest tilt stays the last frame's.
    this.wantTilt(camera, values, HIGH_TILT);
    // Never above the tilt the camera has: a terrain clamp holding it lower stays.
    if ((values[WANTED_TILT] ?? 0) > camera.pose.tiltRad && this.clamped) return;
    camera.pose.tiltRad = values[WANTED_TILT] ?? 0;
    camera.update();
  }

  /**
   * The largest tilt at the camera's range into `out[slot]` (the sky limit, at most the constraints' and the policy's
   * caps), and the tilt the mode wants with its offset, from 0° to it, into `values[WANTED_TILT]`.
   */
  private wantTilt(camera: Camera, out: Float64Array, slot: number): void {
    const values = this.values;
    limits[0] = camera.pose.rangeMeters;
    limits[1] = camera.pose.targetHeightMeters;
    limits[2] = camera.fovYRad;
    limits[3] = this.morph.factors[0] ?? 0;
    skyTiltLimitRad(limits);
    // Locals, not slots: one read each (NaN caps compare false).
    let max = limits[6] ?? 0;
    const cap = values[TILT_CAP] ?? Number.NaN;
    const policyCap = values[POLICY_CAP] ?? Number.NaN;
    if (max > cap) max = cap;
    if (max > policyCap) max = policyCap;
    const wanted = (values[TARGET_TILT] ?? 0) + (values[TILT_OFFSET] ?? 0);
    out[slot] = max;
    values[WANTED_TILT] = wanted < 0 ? 0 : wanted > max ? max : wanted;
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

  /**
   * The tilt policy at the camera's distance to the point looked at (F625): the automatic tilt rises from 0 at
   * `tiltPolicy[1]` to `tiltPolicy[2]` at a quarter of it, and the cap falls from 90° `tiltPolicy[4]` octaves within
   * the lock (one when 0, F641) to 0 at the lock, each eased in the distance's logarithm, so neither jumps.
   */
  private applyPolicy(camera: Camera): void {
    const policy = this.tiltPolicy;
    const lock = policy[0] ?? 0;
    if (!(lock > 0)) {
      this.values[POLICY_CAP] = Number.NaN;
      return;
    }
    const range = camera.pose.rangeMeters;
    policyStep[0] = 0;
    policyStep[1] = 2;
    policyStep[2] = Math.log2((policy[1] ?? 0) / range);
    smootherstepInto(policyStep);
    this.values[AUTO_TILT] = (policyStep[3] ?? 0) * (policy[2] ?? 0);
    policyStep[1] = policy[4] || 1;
    policyStep[2] = Math.log2(lock / range);
    smootherstepInto(policyStep);
    this.values[POLICY_CAP] = (policyStep[3] ?? 0) * (Math.PI / 2);
  }

  /** The ground zoom at the screen center and the Auto curves there, into `curveValues` and `values`. */
  private computeCurves(camera: Camera): void {
    // groundZoomForRange written out: a double returned from a call is boxed (ADR 0018).
    const metersPerPixel = (camera.pose.rangeMeters * Math.tan(camera.fovYRad / 2)) / (camera.heightPx / 2);
    groundZoom[0] = Math.log2(METERS_PER_PIXEL_AT_ZERO / metersPerPixel);
    this.values[GROUND_ZOOM] = groundZoom[0];
    evaluateViewCurves(this.curves, groundZoom, curveValues);
    // The view's ground radius in radians, longer toward the horizon when tilted, against its distance to the caps.
    const cosine = Math.cos(camera.pose.tiltRad);
    const halfDiagonalPx = Math.sqrt(camera.widthPx * camera.widthPx + camera.heightPx * camera.heightPx) / 2;
    const radiusRad =
      (metersPerPixel * halfDiagonalPx) /
      WGS84.semiMajorAxisMeters /
      (cosine > MIN_TILT_COSINE ? cosine : MIN_TILT_COSINE);
    // The morph fades out from two view radii from a cap to one (KB-211): the Mercator plane cannot show the caps beyond
    // ±85.0511°, so a view that reaches them stays a globe.
    capStep[0] = radiusRad;
    capStep[1] = 2 * radiusRad;
    capStep[2] = WEB_MERCATOR_MAX_LATITUDE_RAD - Math.abs(camera.pose.targetLatitudeRad);
    smootherstepInto(capStep);
    this.values[CAP_KEEP] = capStep[3] ?? 1;
    curveValues[CURVE_MORPH] = (curveValues[CURVE_MORPH] ?? 0) * (capStep[3] ?? 1);
    this.values[AUTO_TILT] = curveValues[2] ?? 0;
    this.applyPolicy(camera);
    this.morph.factors[0] = (curveValues[CURVE_MORPH] ?? 0) + (this.values[MORPH_OFFSET] ?? 0);
  }
}

/**
 * True when, at the tilt in `values[slot]` (radians), the eye stands at least the clearance (`limits[5]`) above the
 * surface probed under it; leaves the camera at that tilt with its ground probed. Doubles stay in arrays (ADR 0018).
 */
function clears(state: ViewState, camera: Camera, values: Float64Array, slot: number, ground: GroundProbe): boolean {
  camera.pose.tiltRad = values[slot] ?? 0;
  camera.update();
  // The relief follows the tilt: each candidate is probed with its own, not the last frame's (KB-153).
  state.update(camera);
  ground.probeGround(camera);
  return camera.eyeGeodetic.heightMeters - camera.groundHeightMeters >= (limits[5] ?? 0);
}

/**
 * The most a terrain limit moves the tilt this frame from the previous one, into `values[STEP]` (KB-170): at most
 * {@link MAX_LIMIT_DROP_RAD}, and less where the relief, which follows the tilt by a smootherstep over 0°–30°, would
 * change by more than {@link MAX_RELIEF_DROP}.
 */
function writeStep(values: Float64Array): void {
  values[STEP] = (values[PREVIOUS_TILT] ?? 0) / RELIEF_TILT_RAD;
  if ((values[STEP] ?? 0) > 1) values[STEP] = 1;
  const x = values[STEP] ?? 0;
  // The relief's change over a full step, by the smootherstep's slope 30 x² (1 − x)².
  values[STEP] = ((30 * x * x * (1 - x) * (1 - x)) / RELIEF_TILT_RAD) * MAX_LIMIT_DROP_RAD;
  values[STEP] =
    (values[STEP] ?? 0) > MAX_RELIEF_DROP
      ? (MAX_LIMIT_DROP_RAD * MAX_RELIEF_DROP) / (values[STEP] ?? 1)
      : MAX_LIMIT_DROP_RAD;
}

/** Shrinks the offset in `values[slot]` by one frame's share, ending it below `floor`. */
function decay(values: Float64Array, slot: number, floor: number): void {
  values[slot] = (values[slot] ?? 0) * (values[KEPT] ?? OFFSET_KEPT);
  if ((values[slot] ?? 0) < floor && (values[slot] ?? 0) > -floor) values[slot] = 0;
}

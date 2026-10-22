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

/** A restored tilt rises by this share of what remains each frame, at least {@link MIN_RESTORE_RAD} (F165, F166). */
const RESTORE_SHARE = 0.25;
const MIN_RESTORE_RAD = (0.1 * Math.PI) / 180;

/**
 * The zoom-driven state of one frame (ADR 0008, ADR 0029): the ground zoom at the screen center, the Auto curves'
 * values there and the morph frame anchored at the camera target. Relief follows its zoom curve, or the applied tilt
 * when that asks for more (a view tilted by hand shows its relief at every zoom). Allocates nothing.
 */
export class ViewState {
  /** The morph of the frame. */
  readonly morph = new MorphFrame();
  /** Ground zoom, automatic tilt and the last applied tilt, in an array: a double field may be boxed (ADR 0018). */
  private readonly values = new Float64Array(3);
  /** The user's chosen tilt, radians: kept apart from the applied one, which clamps never write here (F164). */
  private readonly chosen = new Float64Array(1);
  /** True when the next frame applies the target tilt at once (a camera cut), not eased. */
  private snap = true;
  /** The current mode; `manual` holds the chosen tilt at every zoom. */
  mode: ViewMode = 'auto';

  /** Ground zoom at the screen center. */
  get groundZoom(): number {
    return this.values[0] ?? 0;
  }

  /** The automatic tilt the Auto curves give at this zoom, radians. */
  get autoTiltRad(): number {
    return this.values[1] ?? 0;
  }

  /** The tilt the user chose, radians: what manual mode shows wherever no clamp applies. */
  get chosenTiltRad(): number {
    return this.chosen[0] ?? 0;
  }

  constructor(readonly curves: ViewCurves) {}

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
  }

  /** A tilt chosen by the user or a view (radians): manual mode, applied at once (ADR 0029). */
  chooseTilt(tiltRad: number): void {
    this.mode = 'manual';
    this.chosen[0] = tiltRad;
    this.snap = true;
  }

  /**
   * Sets the camera's applied tilt for this frame (F161–F166): the mode's target (the Auto curve, 0° in 2D, the chosen
   * tilt in manual mode), clamped where the camera would enter the terrain (`clearanceMeters` above the surface under
   * the eye; 0 without terrain) or where empty sky would fill more than the top third of the screen. A lower limit
   * applies at once; a tilt released by a limit eases back. Updates the camera; allocates nothing.
   */
  applyTilt(camera: Camera, clearanceMeters: number): void {
    this.computeCurves(camera);
    const target = this.mode === 'auto' ? (this.values[1] ?? 0) : this.mode === '2d' ? 0 : (this.chosen[0] ?? 0);
    limits[0] = camera.pose.rangeMeters;
    limits[1] = camera.pose.targetHeightMeters;
    limits[2] = camera.fovYRad;
    limits[3] = this.morph.factors[0] ?? 0;
    limits[4] = camera.groundHeightMeters;
    limits[5] = clearanceMeters;
    skyTiltLimitRad(limits);
    let allowed = limits[6] ?? 0;
    if (clearanceMeters > 0) {
      terrainTiltLimitRad(limits);
      const terrain = limits[7] ?? 0;
      if (terrain < allowed) allowed = terrain;
    }
    const goal = target < allowed ? target : allowed;
    const previous = this.values[2] ?? 0;
    let applied = goal;
    if (!this.snap && goal > previous) {
      const step = (goal - previous) * RESTORE_SHARE;
      applied = previous + (step > MIN_RESTORE_RAD ? step : MIN_RESTORE_RAD);
      if (applied > goal) applied = goal;
    }
    this.snap = false;
    this.values[2] = applied;
    camera.pose.tiltRad = applied;
    camera.update();
  }

  /** Recomputes the state from the camera's pose and viewport (after {@link Camera.update}). */
  update(camera: Camera): void {
    this.computeCurves(camera);
    tiltStep[0] = 0;
    tiltStep[1] = RELIEF_TILT_RAD;
    tiltStep[2] = camera.pose.tiltRad;
    smootherstepInto(tiltStep);
    const zoomRelief = curveValues[CURVE_RELIEF] ?? 0;
    const tiltRelief = tiltStep[3] ?? 0;
    anchor[0] = camera.pose.targetLongitudeRad;
    anchor[1] = camera.pose.targetLatitudeRad;
    factors[0] = curveValues[CURVE_MORPH] ?? 0;
    factors[1] = zoomRelief > tiltRelief ? zoomRelief : tiltRelief;
    this.morph.update(anchor, factors);
  }

  /** The ground zoom at the screen center and the Auto curves there, into `curveValues` and `values`. */
  private computeCurves(camera: Camera): void {
    // groundZoomForRange written out: a double returned from a call is boxed (ADR 0018).
    const metersPerPixel = (camera.pose.rangeMeters * Math.tan(camera.fovYRad / 2)) / (camera.heightPx / 2);
    groundZoom[0] = Math.log2(METERS_PER_PIXEL_AT_ZERO / metersPerPixel);
    this.values[0] = groundZoom[0];
    evaluateViewCurves(this.curves, groundZoom, curveValues);
    this.values[1] = curveValues[2] ?? 0;
    this.morph.factors[0] = curveValues[CURVE_MORPH] ?? 0;
  }
}

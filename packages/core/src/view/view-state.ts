import type { Camera } from '../camera/camera.js';
import { WGS84 } from '../geodesy/wgs84.js';
import { CURVE_MORPH, CURVE_RELIEF, evaluateViewCurves, smootherstepInto, type ViewCurves } from './curves.js';
import { MorphFrame } from './morph.js';

/** Applied tilt over which relief reaches full height whatever the zoom (ADR 0029), radians: 0° to 30°. */
const RELIEF_TILT_RAD = (30 * Math.PI) / 180;
/** The equator's length over 512 px: ground meters per pixel at ground zoom 0 (`groundZoomForRange`). */
const METERS_PER_PIXEL_AT_ZERO = (2 * Math.PI * WGS84.semiMajorAxisMeters) / 512;

const groundZoom = new Float64Array(1);
const curveValues = new Float64Array(3);
const anchor = new Float64Array(2);
const factors = new Float64Array(2);
const tiltStep = new Float64Array(4);

/**
 * The zoom-driven state of one frame (ADR 0008, ADR 0029): the ground zoom at the screen center, the Auto curves'
 * values there and the morph frame anchored at the camera target. Relief follows its zoom curve, or the applied tilt
 * when that asks for more (a view tilted by hand shows its relief at every zoom). Allocates nothing.
 */
export class ViewState {
  /** The morph of the frame. */
  readonly morph = new MorphFrame();
  /** Ground zoom and automatic tilt, in an array: a double stored in a field may be boxed (ADR 0018). */
  private readonly values = new Float64Array(2);

  /** Ground zoom at the screen center. */
  get groundZoom(): number {
    return this.values[0] ?? 0;
  }

  /** The automatic tilt the Auto curves give at this zoom, radians. */
  get autoTiltRad(): number {
    return this.values[1] ?? 0;
  }

  constructor(readonly curves: ViewCurves) {}

  /** Recomputes the state from the camera's pose and viewport (after {@link Camera.update}). */
  update(camera: Camera): void {
    // groundZoomForRange written out: a double returned from a call is boxed (ADR 0018).
    const metersPerPixel = (camera.pose.rangeMeters * Math.tan(camera.fovYRad / 2)) / (camera.heightPx / 2);
    groundZoom[0] = Math.log2(METERS_PER_PIXEL_AT_ZERO / metersPerPixel);
    this.values[0] = groundZoom[0];
    evaluateViewCurves(this.curves, groundZoom, curveValues);
    this.values[1] = curveValues[2] ?? 0;
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
}

import type { GeoPosition } from '@vibeglobe/core';
import type { MutablePoint, ReleaseVelocity } from './animators.js';
import { type GestureContext, TapDetector } from './gesture-context.js';
import { SampleRing } from './samples.js';

const DEG = 180 / Math.PI;
/** A last finger lifted within this time of the one before it ends a two-finger gesture (its velocity carries on). */
const LIFT_TOGETHER_MS = 50;

/** Wraps an angle difference into (−π, π]. */
function wrapRad(a: number): number {
  return a - 2 * Math.PI * Math.round(a / (2 * Math.PI));
}

/**
 * Touch gestures (ADR 0009 §4). One finger pans. Two fingers start undecided: side by side fingers that both move
 * vertically the same way lock into an exclusive tilt; otherwise pan about the midpoint combines with pinch zoom and
 * twist rotation, each once past its threshold and from its own start, so nothing catches up. Adding or lifting a
 * finger re-baselines with zero delta. Taps: a double tap zooms in at the tap, a two-finger tap zooms out about the
 * midpoint. A third finger is ignored.
 */
export class TouchGestures {
  private readonly ids = [-1, -1];
  private readonly x = new Float64Array(2);
  private readonly y = new Float64Array(2);
  private readonly downX = new Float64Array(2);
  private readonly downY = new Float64Array(2);
  private count = 0;
  private latestMs = 0;
  private dirty = false;
  private rebaseline = false;
  // Gesture since the last re-baseline.
  private anchor: GeoPosition | undefined;
  private readonly mid: MutablePoint = { xPx: 0, yPx: 0 };
  private readonly applied: MutablePoint = { xPx: 0, yPx: 0 };
  private startMs = 0;
  private startDistance = 1;
  private startAngle = 0;
  private readonly startX = new Float64Array(2);
  private readonly startY = new Float64Array(2);
  private lastDistance = 1;
  private lastAngle = 0;
  private unwrappedAngle = 0;
  private tiltPossible = false;
  private tilting = false;
  private zooming = false;
  private rotating = false;
  private readonly samples = new SampleRing();
  // Taps since the first finger landed.
  private sessionStartMs = 0;
  private sessionFingers = 0;
  private sessionMoved = false;
  private readonly tapMid: MutablePoint = { xPx: 0, yPx: 0 };
  private readonly taps: TapDetector;
  // Velocity of a two-finger gesture whose fingers lift one after the other.
  private readonly carried: ReleaseVelocity = { panXPx: 0, panYPx: 0, headingDeg: 0, tiltDeg: 0, zoomLevels: 0 };
  private carriedMs = -Infinity;
  private readonly velocity = new Float64Array(4);
  private readonly release: ReleaseVelocity = { panXPx: 0, panYPx: 0, headingDeg: 0, tiltDeg: 0, zoomLevels: 0 };

  constructor(private readonly context: GestureContext) {
    this.taps = new TapDetector(context.options);
  }

  /** True while a finger is down. */
  get active(): boolean {
    return this.count > 0;
  }

  /** A finger lands; returns false for a third finger (ignored). */
  down(id: number, xPx: number, yPx: number, timeMs: number): boolean {
    if (this.count === 2) return false;
    const slot = this.ids[0] === -1 ? 0 : 1;
    this.ids[slot] = id;
    this.x[slot] = this.downX[slot] = xPx;
    this.y[slot] = this.downY[slot] = yPx;
    if (this.count === 0) {
      this.context.interrupt();
      this.sessionStartMs = timeMs;
      this.sessionFingers = 0;
      this.sessionMoved = false;
    }
    this.count++;
    this.sessionFingers = Math.max(this.sessionFingers, this.count);
    if (this.count === 2) {
      this.tapMid.xPx = ((this.downX[0] ?? 0) + (this.downX[1] ?? 0)) / 2;
      this.tapMid.yPx = ((this.downY[0] ?? 0) + (this.downY[1] ?? 0)) / 2;
    }
    this.latestMs = timeMs;
    this.rebaseline = true;
    return true;
  }

  /** A finger moves; returns whether a frame is needed. */
  move(id: number, xPx: number, yPx: number, timeMs: number): boolean {
    const slot = this.ids.indexOf(id);
    if (slot < 0) return false;
    this.x[slot] = xPx;
    this.y[slot] = yPx;
    const { tapMaxMovePx } = this.context.options.touch;
    if (Math.hypot(xPx - (this.downX[slot] ?? 0), yPx - (this.downY[slot] ?? 0)) > tapMaxMovePx) {
      this.sessionMoved = true;
    }
    this.latestMs = timeMs;
    this.measure();
    this.samples.add(timeMs, this.mid.xPx, this.mid.yPx, Math.log2(this.lastDistanceNow()), this.unwrappedAngle);
    this.dirty = true;
    return true;
  }

  /** A finger lifts or is cancelled; returns whether a frame is needed. */
  up(id: number, timeMs: number, cancelled: boolean): boolean {
    const slot = this.ids.indexOf(id);
    if (slot < 0) return false;
    if (this.count === 2) this.carryVelocity(timeMs);
    this.ids[slot] = -1;
    if (slot === 0 && this.ids[1] !== -1) {
      // Keep the remaining finger in slot 0.
      this.ids[0] = this.ids[1] ?? -1;
      this.ids[1] = -1;
      this.x[0] = this.x[1] ?? 0;
      this.y[0] = this.y[1] ?? 0;
      this.downX[0] = this.downX[1] ?? 0;
      this.downY[0] = this.downY[1] ?? 0;
    }
    this.count--;
    this.latestMs = timeMs;
    if (this.count > 0) {
      this.rebaseline = true;
      return true;
    }
    if (cancelled) {
      this.reset();
      return false;
    }
    return this.finish(timeMs);
  }

  private reset(): void {
    this.anchor = undefined;
    this.dirty = false;
    this.rebaseline = false;
    this.carriedMs = -Infinity;
  }

  /** The midpoint, distance and unwrapped angle of the current fingers. */
  private measure(): void {
    if (this.count < 2) {
      this.mid.xPx = this.x[0] ?? 0;
      this.mid.yPx = this.y[0] ?? 0;
      return;
    }
    this.mid.xPx = ((this.x[0] ?? 0) + (this.x[1] ?? 0)) / 2;
    this.mid.yPx = ((this.y[0] ?? 0) + (this.y[1] ?? 0)) / 2;
    const angle = Math.atan2((this.y[1] ?? 0) - (this.y[0] ?? 0), (this.x[1] ?? 0) - (this.x[0] ?? 0));
    this.unwrappedAngle += wrapRad(angle - this.unwrappedAngle);
  }

  private lastDistanceNow(): number {
    if (this.count < 2) return 1;
    return Math.max(1, Math.hypot((this.x[1] ?? 0) - (this.x[0] ?? 0), (this.y[1] ?? 0) - (this.y[0] ?? 0)));
  }

  private start(): void {
    this.rebaseline = false;
    this.dirty = false;
    this.measure();
    this.anchor = this.context.options.gestures.dragPan ? this.context.port.grab(this.mid) : undefined;
    this.applied.xPx = this.mid.xPx;
    this.applied.yPx = this.mid.yPx;
    this.startMs = this.latestMs;
    this.startDistance = this.lastDistance = this.lastDistanceNow();
    this.startAngle = this.lastAngle = this.unwrappedAngle;
    this.startX[0] = this.x[0] ?? 0;
    this.startX[1] = this.x[1] ?? 0;
    this.startY[0] = this.y[0] ?? 0;
    this.startY[1] = this.y[1] ?? 0;
    const { gestures } = this.context.options;
    this.tiltPossible = this.count === 2 && gestures.touchTilt && this.context.port.canRotate;
    this.tilting = false;
    this.zooming = false;
    this.rotating = false;
    this.samples.clear();
    this.samples.add(this.latestMs, this.mid.xPx, this.mid.yPx, Math.log2(this.startDistance), this.unwrappedAngle);
  }

  /** Turns the recorded fingers into camera changes once per frame. */
  apply(): void {
    if (this.count === 0) return;
    if (this.rebaseline) {
      this.start();
      return;
    }
    if (!this.dirty) return;
    this.dirty = false;
    if (this.count === 2) this.applyTwoFingers();
    else this.applyPan();
  }

  private applyPan(): void {
    if (this.anchor) this.context.port.dragTo(this.anchor, this.mid);
    this.applied.xPx = this.mid.xPx;
    this.applied.yPx = this.mid.yPx;
  }

  /**
   * Decides whether two fingers tilt: side by side, both moving mostly vertically the same way, early in the gesture.
   * Any other motion past the start distance, or the decision time passing, rules the tilt out.
   */
  private decideTilt(): void {
    const { tiltStartPx, tiltDecisionMs } = this.context.options.touch;
    const dx0 = (this.x[0] ?? 0) - (this.startX[0] ?? 0);
    const dx1 = (this.x[1] ?? 0) - (this.startX[1] ?? 0);
    const dy0 = (this.y[0] ?? 0) - (this.startY[0] ?? 0);
    const dy1 = (this.y[1] ?? 0) - (this.startY[1] ?? 0);
    const sideBySide =
      Math.abs((this.x[1] ?? 0) - (this.x[0] ?? 0)) > Math.abs((this.y[1] ?? 0) - (this.y[0] ?? 0));
    const vertical =
      Math.abs(dy0) >= tiltStartPx &&
      Math.abs(dy1) >= tiltStartPx &&
      dy0 * dy1 > 0 &&
      Math.abs(dy0) > Math.abs(dx0) &&
      Math.abs(dy1) > Math.abs(dx1);
    const early = this.latestMs - this.startMs <= tiltDecisionMs;
    if (sideBySide && vertical && early) {
      this.tilting = true;
      this.applied.yPx = this.mid.yPx;
      this.tiltPossible = false;
    } else if (!sideBySide || !early || Math.max(Math.hypot(dx0, dy0), Math.hypot(dx1, dy1)) >= tiltStartPx) {
      this.tiltPossible = false;
    }
  }

  private applyTwoFingers(): void {
    const { port, options } = this.context;
    if (this.tiltPossible) this.decideTilt();
    if (this.tilting) {
      const dy = this.mid.yPx - this.applied.yPx;
      this.applied.yPx = this.mid.yPx;
      port.rotate(
        0,
        (-dy * options.tiltDegPerViewportHeight) / Math.max(1, this.context.heightPx()),
        options.maxTiltDeg,
      );
      return;
    }
    const { pinchThresholdLevels, rotateThresholdPx } = options.touch;
    const distance = this.lastDistanceNow();
    if (!this.zooming && options.gestures.touchZoom) {
      this.zooming = Math.abs(Math.log2(distance / this.startDistance)) >= pinchThresholdLevels;
      if (this.zooming) this.lastDistance = distance;
    }
    if (!this.rotating && options.gestures.touchRotate && port.canRotate) {
      this.rotating = Math.abs(this.unwrappedAngle - this.startAngle) * (distance / 2) >= rotateThresholdPx;
      if (this.rotating) this.lastAngle = this.unwrappedAngle;
    }
    if (this.zooming || this.rotating) this.tiltPossible = false;
    if (this.rotating) {
      // Fingers turning clockwise on screen turn the map clockwise: the heading decreases.
      port.rotate(-(this.unwrappedAngle - this.lastAngle) * DEG, 0, options.maxTiltDeg);
      this.lastAngle = this.unwrappedAngle;
    }
    if (this.zooming) {
      port.zoomAt(this.mid, Math.log2(distance / this.lastDistance));
      this.lastDistance = distance;
    }
    this.applyPan();
  }

  /** Measures a two-finger gesture's velocity as one of its fingers lifts. */
  private carryVelocity(timeMs: number): void {
    this.measureRelease(this.carried);
    this.carriedMs = timeMs;
  }

  private measureRelease(out: ReleaseVelocity): void {
    const { options } = this.context;
    this.samples.velocity(options.inertia.velocityWindowMs, this.velocity);
    const vx = this.velocity[0] ?? 0;
    const vy = this.velocity[1] ?? 0;
    out.panXPx = out.panYPx = out.headingDeg = out.tiltDeg = out.zoomLevels = 0;
    if (this.tilting) {
      out.tiltDeg = (-vy * options.tiltDegPerViewportHeight) / Math.max(1, this.context.heightPx());
      return;
    }
    const speed = Math.hypot(vx, vy);
    const scale = speed > 0 ? Math.min(1, options.inertia.maxPanSpeedPxPerS / 1000 / speed) : 0;
    out.panXPx = vx * scale;
    out.panYPx = vy * scale;
    if (this.zooming) out.zoomLevels = this.velocity[2] ?? 0;
    if (this.rotating) out.headingDeg = -(this.velocity[3] ?? 0) * DEG;
  }

  /** The last finger lifted: a tap, a double tap, a two-finger tap, or inertia. */
  private finish(timeMs: number): boolean {
    const { options, zoom, port, inertia } = this.context;
    const { tapMaxMs } = options.touch;
    const quick = timeMs - this.sessionStartMs <= tapMaxMs && !this.sessionMoved;
    const anchor = this.anchor;
    const carried = timeMs - this.carriedMs <= LIFT_TOGETHER_MS;
    this.reset();
    if (quick && this.sessionFingers === 2) {
      if (options.gestures.touchZoom) zoom.add(-1, this.tapMid.xPx, this.tapMid.yPx, options.zoomAnimationMs);
      this.taps.reset();
      return options.gestures.touchZoom;
    }
    if (quick && this.sessionFingers === 1) {
      if (this.taps.tap(this.downX[0] ?? 0, this.downY[0] ?? 0, this.sessionStartMs, timeMs)) {
        if (options.gestures.doubleClickZoom)
          zoom.add(1, this.downX[0] ?? 0, this.downY[0] ?? 0, options.zoomAnimationMs);
        return options.gestures.doubleClickZoom;
      }
      return false;
    }
    this.taps.reset();
    if (!options.gestures.inertia) return false;
    if (carried) Object.assign(this.release, this.carried);
    else this.measureRelease(this.release);
    inertia.start(this.release, this.context.inertiaTaus(), anchor, this.applied, options.maxTiltDeg);
    if (inertia.active) port.requestNextFrame();
    return inertia.active;
  }
}

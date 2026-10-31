// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { GeoPosition } from '@vibeglobe/core';
import type { MutablePoint, ReleaseVelocity } from './animators.js';
import { type GestureContext, TapDetector } from './gesture-context.js';
import { SampleRing } from './samples.js';

const DEG = 180 / Math.PI;
/** A last finger lifted within this time of the one before it ends a two-finger gesture (its velocity carries on). */
const LIFT_TOGETHER_MS = 50;
/** How long a frame waits at least for the partner of a finger that moved alone, when they moved in step so far (KB-183). */
const PARTNER_WAIT_MS = 100;

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
  /** Each finger's last and previous move times, to see a touch event whose fingers are half reported. */
  private readonly moveMs = new Float64Array(2);
  private readonly previousMoveMs = new Float64Array(2);
  private latestMs = 0;
  private dirty = false;
  private rebaseline = false;
  // Gesture since the last re-baseline.
  private anchor: GeoPosition | undefined;
  /** The pan turns the globe about the screen center: the fingers left the globe's disc (KB-202). */
  private trackball = false;
  private readonly mid: MutablePoint = { xPx: 0, yPx: 0 };
  private readonly applied: MutablePoint = { xPx: 0, yPx: 0 };
  /** The midpoint when the fingers last changed, where the next frame grabs the anchor. */
  private readonly startMid: MutablePoint = { xPx: 0, yPx: 0 };
  private tiltY = 0;
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
  /** The report frames wait for the partner of (KB-183), NaN for none, and the host time the wait began. */
  private waitedForMs = Number.NaN;
  private waitStartMs = 0;
  private readonly tapMid: MutablePoint = { xPx: 0, yPx: 0 };
  private readonly taps: TapDetector;
  // Velocity of a two-finger gesture whose fingers lift one after the other.
  private readonly carried: ReleaseVelocity = { panXPx: 0, panYPx: 0, headingDeg: 0, tiltDeg: 0, zoomLevels: 0 };
  private carriedMs = -Infinity;
  private carriedTrackball = false;
  private readonly carriedPixel: MutablePoint = { xPx: 0, yPx: 0 };
  private readonly velocity = new Float64Array(4);
  private readonly release: ReleaseVelocity = { panXPx: 0, panYPx: 0, headingDeg: 0, tiltDeg: 0, zoomLevels: 0 };
  /** The time constants of a touch release: a twist's heading glides with `twistTauMs` (KB-177). */
  private readonly taus = { panTauMs: 1, rotateTauMs: 1, twistTauMs: 1, tiltTauMs: 1, zoomTauMs: 1 };

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
      this.context.port.interruptMovement();
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
    this.snapshot();
    return true;
  }

  /** A finger moves; returns whether a frame is needed. */
  move(id: number, xPx: number, yPx: number, timeMs: number): boolean {
    const slot = this.ids.indexOf(id);
    if (slot < 0) return false;
    this.x[slot] = xPx;
    this.y[slot] = yPx;
    this.previousMoveMs[slot] = this.moveMs[slot] ?? 0;
    this.moveMs[slot] = timeMs;
    const { tapMaxMovePx } = this.context.options.touch;
    if (Math.hypot(xPx - (this.downX[slot] ?? 0), yPx - (this.downY[slot] ?? 0)) > tapMaxMovePx) {
      this.sessionMoved = true;
    }
    this.latestMs = timeMs;
    this.measure();
    this.samples.add(timeMs, this.mid.xPx, this.mid.yPx, Math.log2(this.lastDistanceNow()), this.unwrappedAngle);
    // The tilt decision depends on event times, so it is made here, not at the next (possibly late) frame.
    if (this.count === 2 && this.tiltPossible) this.decideTilt();
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
      for (const a of [this.ids, this.x, this.y, this.downX, this.downY, this.moveMs, this.previousMoveMs])
        a[0] = a[1] ?? 0;
      this.ids[1] = -1;
    }
    this.count--;
    this.latestMs = timeMs;
    if (this.count > 0) {
      this.snapshot();
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
    this.trackball = false;
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

  /**
   * Re-baselines at a finger change, from the positions at that moment: distance, angle, the tilt decision's start and
   * the samples. The next frame grabs the anchor at the midpoint recorded here, then applies any motion since.
   */
  private snapshot(): void {
    this.rebaseline = true;
    this.measure();
    this.startMid.xPx = this.mid.xPx;
    this.startMid.yPx = this.mid.yPx;
    this.startMs = this.latestMs;
    this.startDistance = this.lastDistance = this.lastDistanceNow();
    this.startAngle = this.lastAngle = this.unwrappedAngle;
    this.startX[0] = this.x[0] ?? 0;
    this.startX[1] = this.x[1] ?? 0;
    this.startY[0] = this.y[0] ?? 0;
    this.startY[1] = this.y[1] ?? 0;
    const { gestures } = this.context.options;
    this.tiltPossible = this.count === 2 && gestures.touchTilt;
    this.tilting = false;
    this.zooming = false;
    this.rotating = false;
    this.samples.clear();
    this.samples.add(this.latestMs, this.mid.xPx, this.mid.yPx, Math.log2(this.startDistance), this.unwrappedAngle);
  }

  /** Grabs the anchor at the midpoint of the last finger change. */
  private start(): void {
    this.rebaseline = false;
    this.anchor = this.context.options.gestures.dragPan ? this.context.port.grab(this.startMid) : undefined;
    this.trackball = this.context.options.gestures.dragPan && !this.anchor;
    this.applied.xPx = this.startMid.xPx;
    this.applied.yPx = this.startMid.yPx;
    this.measure();
  }

  /** Turns the recorded fingers into camera changes once per frame. */
  apply(): void {
    if (this.count === 0) return;
    if (this.rebaseline) this.start();
    if (!this.dirty) return;
    if (this.count === 2 && this.halfReported()) return;
    this.dirty = false;
    if (this.count === 2) this.applyTwoFingers();
    else this.applyPan();
  }

  /**
   * True while the fingers moved in step so far and only one has reported the latest touch event: the browser
   * dispatches each finger's move separately, and a frame between them would show half the motion. The wait lasts at
   * least one frame, however late it runs (KB-183: a 40 ms wait on the clock alone let a late frame through), and at
   * least {@link PARTNER_WAIT_MS}, since a busy page can run more than one frame between the two reports (F180 on CI);
   * a finger whose partner has not reported by then really stopped, and is applied.
   */
  private halfReported(): boolean {
    const a0 = this.moveMs[0] ?? 0;
    const a1 = this.moveMs[1] ?? 0;
    const p0 = this.previousMoveMs[0] ?? 0;
    const p1 = this.previousMoveMs[1] ?? 0;
    const half = (a0 > a1 && p0 === a1) || (a1 > a0 && p1 === a0);
    if (!half) return false;
    const latest = a0 > a1 ? a0 : a1;
    const port = this.context.port;
    if (this.waitedForMs !== latest) {
      this.waitedForMs = latest;
      this.waitStartMs = port.hostMs();
    } else if (port.hostMs() - this.waitStartMs >= PARTNER_WAIT_MS) return false;
    port.requestNextFrame();
    return true;
  }

  /**
   * Keeps the grabbed point under the fingers while they are over the globe; off its disc their motion turns the
   * globe about the screen center like a virtual trackball, and the globe is grabbed again where they return (KB-202).
   */
  private applyPan(): void {
    const { port, options } = this.context;
    if (options.gestures.dragPan) {
      if (this.anchor && port.grab(this.mid)) {
        port.dragTo(this.anchor, this.mid);
        this.trackball = false;
      } else {
        const dx = this.mid.xPx - this.applied.xPx;
        const dy = this.mid.yPx - this.applied.yPx;
        if (dx !== 0 || dy !== 0) port.pivotPan(dx, dy, this.context.widthPx(), this.context.heightPx());
        this.anchor = port.grab(this.mid);
        this.trackball = true;
      }
    }
    this.applied.xPx = this.mid.xPx;
    this.applied.yPx = this.mid.yPx;
  }

  /**
   * Decides whether two fingers tilt: side by side, both moving mostly vertically the same way, early in the gesture.
   * Sideways or opposite motion, or the decision time passing, rules the tilt out.
   */
  private decideTilt(): void {
    const { tiltStartPx, tiltDecisionMs } = this.context.options.touch;
    const dx0 = (this.x[0] ?? 0) - (this.startX[0] ?? 0);
    const dx1 = (this.x[1] ?? 0) - (this.startX[1] ?? 0);
    const dy0 = (this.y[0] ?? 0) - (this.startY[0] ?? 0);
    const dy1 = (this.y[1] ?? 0) - (this.startY[1] ?? 0);
    const sideBySide = Math.abs((this.x[1] ?? 0) - (this.x[0] ?? 0)) > Math.abs((this.y[1] ?? 0) - (this.y[0] ?? 0));
    const vertical =
      Math.abs(dy0) >= tiltStartPx &&
      Math.abs(dy1) >= tiltStartPx &&
      dy0 * dy1 > 0 &&
      Math.abs(dy0) > Math.abs(dx0) &&
      Math.abs(dy1) > Math.abs(dx1);
    const early = this.latestMs - this.startMs <= tiltDecisionMs;
    if (sideBySide && vertical && early) {
      this.tilting = true;
      this.tiltY = this.mid.yPx;
      this.tiltPossible = false;
    } else {
      // Fingers report one at a time: only motion that contradicts a tilt rules it out.
      const sideways = (dx: number, dy: number): boolean =>
        Math.hypot(dx, dy) >= tiltStartPx && Math.abs(dx) >= Math.abs(dy);
      const opposite = Math.abs(dy0) >= tiltStartPx && Math.abs(dy1) >= tiltStartPx && dy0 * dy1 < 0;
      if (!sideBySide || !early || opposite || sideways(dx0, dy0) || sideways(dx1, dy1)) this.tiltPossible = false;
    }
  }

  private applyTwoFingers(): void {
    const { port, options } = this.context;
    if (this.tilting) {
      const dy = this.mid.yPx - this.tiltY;
      this.tiltY = this.mid.yPx;
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
    if (!this.rotating && options.gestures.touchRotate) {
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
    this.measureRelease(this.carried, timeMs);
    this.carriedMs = timeMs;
    // A frame may re-anchor at the remaining finger before it lifts too: inertia continues the two-finger gesture.
    this.carriedTrackball = this.trackball;
    this.carriedPixel.xPx = this.applied.xPx;
    this.carriedPixel.yPx = this.applied.yPx;
  }

  private measureRelease(out: ReleaseVelocity, releaseMs: number): void {
    const { options } = this.context;
    const { velocityWindowMs, stillMs, stillPx } = options.inertia;
    this.samples.velocity(velocityWindowMs, this.velocity, releaseMs, stillMs, stillPx);
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
    const carried = timeMs - this.carriedMs <= LIFT_TOGETHER_MS;
    const trackball = carried ? this.carriedTrackball : this.trackball;
    const pixel = carried ? this.carriedPixel : this.applied;
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
    else this.measureRelease(this.release, timeMs);
    Object.assign(this.taus, this.context.inertiaTaus());
    this.taus.rotateTauMs = this.taus.twistTauMs;
    const widthPx = this.context.widthPx();
    const heightPx = this.context.heightPx();
    // The glide turns the globe about the screen center as fast as the fingers did where they lifted (KB-202).
    const release = this.release;
    const pivot = trackball ? 1 : port.pivotScale(pixel, release.panXPx, release.panYPx, widthPx, heightPx);
    const speed = Math.hypot(release.panXPx, release.panYPx) * pivot;
    const scale = speed > 0 ? (pivot * Math.min(speed, options.inertia.maxPanSpeedPxPerS / 1000)) / speed : 0;
    release.panXPx *= scale;
    release.panYPx *= scale;
    inertia.start(release, this.taus, options.gestures.dragPan, pixel, options.maxTiltDeg, widthPx, heightPx);
    if (inertia.active) port.requestNextFrame();
    return inertia.active;
  }
}

import type { GeoPosition } from '@vibeglobe/core';
import type { MutablePoint, ReleaseVelocity } from './animators.js';
import { type GestureContext, TapDetector } from './gesture-context.js';
import { SampleRing } from './samples.js';
import type { ZoomBox } from './zoom-box.js';

/** A mouse click may last this long and still count toward a double click. */
const CLICK_MAX_MS = 500;

/** What a mouse press starts. */
type MouseMode = 'none' | 'pan' | 'rotate' | 'box';

/** A press: canvas position, event time, button and modifiers. */
export interface MousePress {
  readonly xPx: number;
  readonly yPx: number;
  readonly timeMs: number;
  readonly button: number;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
}

/**
 * Mouse and pen gestures (ADR 0009 §4): primary drag pans keeping the grabbed point under the pointer, right-drag and
 * Ctrl+drag rotate (horizontal) and tilt (vertical) about the screen-center target, Shift+drag draws a zoom box, a
 * double click zooms in one level at the pointer. DOM handlers only record; {@link apply} runs once per frame.
 */
export class MouseGestures {
  pointerId: number | undefined;
  private mode: MouseMode = 'none';
  /** Started with Ctrl: releasing Ctrl ends the rotation. */
  private ctrlRotate = false;
  private anchor: GeoPosition | undefined;
  private grabPending = false;
  private movePending = false;
  private releasePending = false;
  private downMs = 0;
  private moved = false;
  private readonly down: MutablePoint = { xPx: 0, yPx: 0 };
  private readonly pointer: MutablePoint = { xPx: 0, yPx: 0 };
  private readonly applied: MutablePoint = { xPx: 0, yPx: 0 };
  private readonly samples = new SampleRing();
  private readonly velocity = new Float64Array(4);
  private readonly release: ReleaseVelocity = { panXPx: 0, panYPx: 0, headingDeg: 0, tiltDeg: 0, zoomLevels: 0 };
  private readonly taps: TapDetector;

  constructor(
    private readonly context: GestureContext,
    private readonly box: ZoomBox,
  ) {
    this.taps = new TapDetector(context.options);
  }

  /** Starts a gesture; returns false when the press starts none (the caller then lets the browser have it). */
  press(id: number, press: MousePress): boolean {
    if (this.pointerId !== undefined) return false;
    const { gestures } = this.context.options;
    const rotate = press.button === 2 || (press.button === 0 && press.ctrlKey);
    let mode: MouseMode = 'none';
    if (rotate && gestures.dragRotate && this.context.port.canRotate) mode = 'rotate';
    else if (press.button === 0 && press.shiftKey && gestures.boxZoom) mode = 'box';
    else if (press.button === 0 && !press.ctrlKey && (gestures.dragPan || gestures.doubleClickZoom)) mode = 'pan';
    if (mode === 'none') return false;
    this.context.interrupt();
    this.pointerId = id;
    this.mode = mode;
    this.ctrlRotate = rotate && press.button === 0;
    this.down.xPx = this.pointer.xPx = this.applied.xPx = press.xPx;
    this.down.yPx = this.pointer.yPx = this.applied.yPx = press.yPx;
    this.downMs = press.timeMs;
    this.moved = false;
    this.grabPending = mode === 'pan' && gestures.dragPan;
    this.movePending = false;
    this.releasePending = false;
    this.samples.clear();
    this.samples.add(press.timeMs, press.xPx, press.yPx);
    if (mode === 'box') this.box.begin(press.xPx, press.yPx);
    return true;
  }

  /** Records a move; returns whether a frame is needed. */
  move(xPx: number, yPx: number, timeMs: number, ctrlKey: boolean): boolean {
    if (this.ctrlRotate && !ctrlKey) {
      // Releasing Ctrl ends the rotation where it is: no pan starts, nothing jumps (F183).
      this.end();
      return false;
    }
    this.pointer.xPx = xPx;
    this.pointer.yPx = yPx;
    const { tapMaxMovePx } = this.context.options.touch;
    if (Math.hypot(xPx - this.down.xPx, yPx - this.down.yPx) > tapMaxMovePx) this.moved = true;
    this.samples.add(timeMs, xPx, yPx);
    if (this.mode === 'box') {
      this.box.update(xPx, yPx);
      return false;
    }
    this.movePending = true;
    return true;
  }

  /** Ends the gesture at a release; returns whether a frame is needed. */
  up(xPx: number, yPx: number, timeMs: number): boolean {
    const mode = this.mode;
    this.pointerId = undefined;
    this.samples.add(timeMs, xPx, yPx);
    if (mode === 'box') {
      this.mode = 'none';
      const { context } = this;
      this.box.finish(context.port, context.widthPx(), context.heightPx(), context.options.zoomAnimationMs * 3);
      return this.box.fitting;
    }
    if (mode === 'pan' && !this.moved && timeMs - this.downMs <= CLICK_MAX_MS) {
      if (this.taps.tap(xPx, yPx, this.downMs, timeMs) && this.context.options.gestures.doubleClickZoom) {
        const { zoom, options } = this.context;
        zoom.add(1, this.down.xPx, this.down.yPx, options.zoomAnimationMs);
        this.end();
        return true;
      }
    } else this.taps.reset();
    this.releasePending = true;
    return true;
  }

  /** Cancels the gesture (pointercancel, lost capture, Escape for the box) without inertia. */
  cancel(): void {
    if (this.mode === 'box') this.box.cancel();
    this.pointerId = undefined;
    this.end();
  }

  private end(): void {
    this.mode = 'none';
    this.pointerId = undefined;
    this.anchor = undefined;
    this.grabPending = false;
    this.movePending = false;
    this.releasePending = false;
  }

  /** Turns the recorded input into camera changes; returns whether the gesture continues next frame. */
  apply(): boolean {
    if (this.movePending) {
      this.movePending = false;
      if (this.mode === 'pan') this.applyPan();
      else if (this.mode === 'rotate') this.applyRotate();
    }
    if (this.releasePending) this.finishRelease();
    return false;
  }

  private applyPan(): void {
    const { port } = this.context;
    if (this.grabPending) {
      this.grabPending = false;
      this.anchor = port.grab(this.down);
    }
    if (!this.anchor) return;
    port.dragTo(this.anchor, this.pointer);
    this.applied.xPx = this.pointer.xPx;
    this.applied.yPx = this.pointer.yPx;
  }

  private applyRotate(): void {
    const { port, options } = this.context;
    const dx = this.pointer.xPx - this.applied.xPx;
    const dy = this.pointer.yPx - this.applied.yPx;
    this.applied.xPx = this.pointer.xPx;
    this.applied.yPx = this.pointer.yPx;
    port.rotate(this.headingPerPx() * dx, -this.tiltPerPx() * dy, options.maxTiltDeg);
  }

  private headingPerPx(): number {
    return this.context.options.rotateDegPerViewportWidth / Math.max(1, this.context.widthPx());
  }

  private tiltPerPx(): number {
    return this.context.options.tiltDegPerViewportHeight / Math.max(1, this.context.heightPx());
  }

  /** The release's own position applies first, then inertia carries on with the drag's velocity. */
  private finishRelease(): void {
    const { options, inertia, port } = this.context;
    const mode = this.mode;
    const anchor = this.anchor;
    this.end();
    if (!options.gestures.inertia || (mode === 'pan' && !anchor) || mode === 'none') return;
    this.samples.velocity(options.inertia.velocityWindowMs, this.velocity);
    const release = this.release;
    release.panXPx = release.panYPx = release.headingDeg = release.tiltDeg = release.zoomLevels = 0;
    const vx = this.velocity[0] ?? 0;
    const vy = this.velocity[1] ?? 0;
    if (mode === 'pan') {
      const speed = Math.hypot(vx, vy);
      const scale = speed > 0 ? Math.min(1, options.inertia.maxPanSpeedPxPerS / 1000 / speed) : 0;
      release.panXPx = vx * scale;
      release.panYPx = vy * scale;
    } else {
      release.headingDeg = vx * this.headingPerPx();
      release.tiltDeg = -vy * this.tiltPerPx();
    }
    inertia.start(release, this.context.inertiaTaus(), anchor, this.applied, options.maxTiltDeg);
    if (inertia.active) port.requestNextFrame();
  }
}

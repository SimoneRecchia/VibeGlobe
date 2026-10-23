import type { HeadingTarget, Inertia, InertiaTaus, KeyMotion, ZoomTarget } from './animators.js';
import type { CameraPort } from './camera-port.js';
import type { ResolvedControlsOptions } from './options.js';

/** What every recognizer shares: the camera, the settings and the running animations. */
export interface GestureContext {
  readonly port: CameraPort;
  readonly options: ResolvedControlsOptions;
  readonly inertia: Inertia;
  readonly zoom: ZoomTarget;
  readonly heading: HeadingTarget;
  readonly keys: KeyMotion;
  /** The viewport in CSS pixels. */
  widthPx(): number;
  heightPx(): number;
  /** Inertia time constants, quartered under reduced motion (ADR 0009 §7). */
  inertiaTaus(): InertiaTaus;
  /** New input takes over: running inertia and the north turn stop where they are (F202); a wheel zoom completes. */
  interrupt(): void;
}

/** Double taps and double clicks (ADR 0009 §4): a second tap soon after and near the first. */
export class TapDetector {
  private lastUpMs = -Infinity;
  private lastXPx = 0;
  private lastYPx = 0;

  constructor(private readonly options: ResolvedControlsOptions) {}

  /** Records a tap pressed at `downMs` and released at `upMs`; returns true when it completes a double tap. */
  tap(xPx: number, yPx: number, downMs: number, upMs: number): boolean {
    const { doubleTapMs, doubleTapMaxPx } = this.options.touch;
    const double =
      downMs - this.lastUpMs <= doubleTapMs && Math.hypot(xPx - this.lastXPx, yPx - this.lastYPx) <= doubleTapMaxPx;
    this.lastUpMs = double ? -Infinity : upMs;
    this.lastXPx = xPx;
    this.lastYPx = yPx;
    return double;
  }

  /** A press that is not a tap (a drag) breaks a double tap. */
  reset(): void {
    this.lastUpMs = -Infinity;
  }
}

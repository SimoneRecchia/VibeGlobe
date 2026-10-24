import type { GeoPosition, Globe, NavigationApi, ScreenPoint } from '@vibeglobe/core';

/**
 * The part of the engine's public API the controls use beyond `NavigationApi`: the home command and the view-mode
 * toggle for their keys, and the fit the zoom box uses. Rotation, the clock and the applied camera come through
 * `NavigationApi` itself.
 */
export type ConnectedGlobe = Partial<Pick<Globe, 'camera' | 'timeMs' | 'jumpTo' | 'fitBounds'>> & {
  /** The home command (F194), used by the Home key when the engine has it. */
  goHome?(): unknown;
  /** The view-mode toggle (F163), used by the 2, 3 and A keys when the engine has it. */
  setViewMode?(mode: '2d' | '3d' | 'auto'): void;
};

/** One frame at 60 Hz. */
const NOMINAL_FRAME_MS = 1000 / 60;

/** How long a measurement of slow frames holds before animations are tried again. */
const SLOW_VERDICT_MS = 5000;

/** Indices of {@link CameraPort.times}. */
export const FRAME_MS = 0;
const PREVIOUS_FRAME = 1;
const FRAME_END_HOST = 2;
const MEASURED_HOST = 3;

/** Every camera change the recognizers make goes through here. */
export class CameraPort {
  globe: ConnectedGlobe | undefined;
  /**
   * The times written every frame, in an array: a returned double, or a double field turned tagged, allocates on every
   * frame (F064, ADR 0018). Indices: the engine time of the frame now starting ({@link FRAME_MS}, set by
   * {@link CameraPort.beginFrame}), of the previous frame's update, the host time when the last animation frame's task
   * ended, and when the host intervals were last measured.
   */
  readonly times = Float64Array.of(Number.NaN, Number.NaN, 0, Number.NEGATIVE_INFINITY);
  /** Where the engine clock is read into. */
  private readonly clock = new Float64Array(1);
  private frameQueued = false;
  /** True when the controls asked for the frame now starting, to continue an animation. */
  private continued = false;
  /** The last two host intervals from the end of an animation frame to the start of the next, and when measured. */
  private readonly intervalsMs = new Float64Array(2);
  private readonly requestNow = (): void => {
    this.frameQueued = false;
    this.continued = true;
    this.times[FRAME_END_HOST] = this.hostNow();
    this.navigation.requestUpdate();
  };

  constructor(
    private readonly navigation: NavigationApi,
    private readonly hostNow: () => number,
  ) {}

  /** Engine time of the previous frame's update, where animations started since then begin. */
  get previousFrameMs(): number {
    return this.times[PREVIOUS_FRAME] ?? Number.NaN;
  }

  /** Engine time, which inertia and smoothing run on (`NavigationApi.timeInto`). */
  nowMs(): number {
    this.navigation.timeInto(this.clock);
    return this.clock[0] ?? 0;
  }

  /** Starts a frame's update: its engine time is `times[FRAME_MS]` from here. */
  beginFrame(): void {
    // The host clock is read only in animation frames: idle frames allocate nothing (ADR 0018).
    if (this.continued) {
      const host = this.hostNow();
      this.intervalsMs[0] = this.intervalsMs[1] ?? 0;
      this.intervalsMs[1] = host - (this.times[FRAME_END_HOST] ?? 0);
      this.times[MEASURED_HOST] = host;
    }
    this.continued = false;
    const times = this.times;
    this.navigation.timeInto(this.clock);
    const now = this.clock[0] ?? 0;
    const last = times[FRAME_MS] ?? Number.NaN;
    // Without an earlier frame, one nominal frame back: input shows in the first frame after it.
    // `last !== last` is Number.isNaN without a builtin call, which can box its argument (F064).
    times[PREVIOUS_FRAME] = last !== last ? now - NOMINAL_FRAME_MS : last;
    times[FRAME_MS] = now;
  }

  /**
   * True when the last two measured animation frames each came at least three time constants of an animation after the
   * one before, within the last 5 s: the display cannot show it, so it applies in one step instead of costing frames
   * (software GPUs, very slow devices). One slow frame, as at start-up, is not enough.
   */
  tooSlowFor(tauMs: number): boolean {
    const limit = 3 * tauMs;
    return (
      (this.intervalsMs[0] ?? 0) >= limit &&
      (this.intervalsMs[1] ?? 0) >= limit &&
      this.hostNow() - (this.times[MEASURED_HOST] ?? Number.NEGATIVE_INFINITY) < SLOW_VERDICT_MS
    );
  }

  /** Host time, on the clock of event timestamps (allocates: not for idle frames). */
  hostMs(): number {
    return this.hostNow();
  }

  /** Asks for a frame from a DOM handler. */
  requestUpdate(): void {
    this.navigation.requestUpdate();
  }

  /**
   * Asks for the next frame from inside `update`: the engine drops a request made during its frame (hook request
   * "M6 input" 3), so it is made once the frame's task is over.
   */
  requestNextFrame(): void {
    if (this.frameQueued) return;
    this.frameQueued = true;
    queueMicrotask(this.requestNow);
  }

  /** {@link NavigationApi.grab}. */
  grab(point: ScreenPoint): GeoPosition | undefined {
    return this.navigation.grab(point);
  }

  /** {@link NavigationApi.dragTo}. */
  dragTo(anchor: GeoPosition, point: ScreenPoint): void {
    this.navigation.dragTo(anchor, point);
  }

  /** Stops a running API movement: a press on the map (`NavigationApi.interruptMovement`, F202). */
  interruptMovement(): void {
    this.navigation.interruptMovement();
  }

  /** Marks the camera changes that follow as the release inertia's (`NavigationApi.coasting`, F200). */
  setCoasting(coasting: boolean): void {
    this.navigation.coasting = coasting;
  }

  /** {@link NavigationApi.zoomAt}, skipped for a zero step. */
  zoomAt(point: ScreenPoint, deltaZoom: number): void {
    if (deltaZoom !== 0) this.navigation.zoomAt(point, deltaZoom);
  }

  /** True when heading and tilt can change (always: `NavigationApi.orbit`). */
  get canRotate(): boolean {
    return true;
  }

  /** The applied heading, in degrees. */
  headingDeg(): number {
    return this.navigation.headingDeg;
  }

  /** The applied tilt in degrees. */
  tiltDeg(): number {
    return this.navigation.tiltDeg;
  }

  /**
   * Rotates and tilts about the screen-center target: the target stays at the screen center, the range is kept, and
   * the new values become the chosen ones. The tilt is clamped to [0, maxTiltDeg].
   */
  rotate(deltaHeadingDeg: number, deltaTiltDeg: number, maxTiltDeg: number): void {
    if (deltaHeadingDeg === 0 && deltaTiltDeg === 0) return;
    const tilt = this.navigation.tiltDeg;
    const clamped = Math.min(Math.max(tilt + deltaTiltDeg, 0), maxTiltDeg) - tilt;
    this.navigation.orbit(deltaHeadingDeg, deltaTiltDeg === 0 ? 0 : clamped);
  }
}

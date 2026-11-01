// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { GeoPosition, Globe, NavigationApi, ScreenPoint } from '@vibeglobe/core';

/**
 * The part of the engine's public API the controls use beyond `NavigationApi`: the home command and the view-mode
 * toggle for their keys, and the fit the zoom box uses. Rotation, the clock and the applied camera come through
 * `NavigationApi` itself.
 */
export type ConnectedGlobe = Partial<Pick<Globe, 'camera' | 'timeMs' | 'jumpTo' | 'fitBounds' | 'viewMode' | 'on'>> & {
  /** The home command (F194), used by the Home key when the engine has it. */
  goHome?(): unknown;
  /** The view-mode toggle (F163), used by the 2, 3 and A keys when the engine has it. */
  setViewMode?(mode: '2d' | '3d' | 'auto'): void;
};

/** One frame at 60 Hz. */
const NOMINAL_FRAME_MS = 1000 / 60;

/** The longest step of a pivot pan: each step grabs again, so the pivot never runs off the globe (KB-202). */
const PIVOT_STEP_PX = 16;
/** The probe length that measures how fast the globe turns per pixel at a screen point (KB-202). */
const PROBE_PX = 2;

/** The great-circle angle between two positions, radians. */
function angleRad(a: GeoPosition, b: GeoPosition): number {
  const RAD = Math.PI / 180;
  const φ1 = a.latitudeDeg * RAD;
  const φ2 = b.latitudeDeg * RAD;
  const s1 = Math.sin((φ2 - φ1) / 2);
  const s2 = Math.sin(((b.longitudeDeg - a.longitudeDeg) * RAD) / 2);
  return 2 * Math.asin(Math.min(1, Math.sqrt(s1 * s1 + Math.cos(φ1) * Math.cos(φ2) * s2 * s2)));
}

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

  /**
   * Moves the globe like a drag of (dx, dy) pixels at the screen center, whatever lies under the pointer (KB-202): the
   * point under the center is grabbed again at every step of at most {@link PIVOT_STEP_PX}, so the motion turns the
   * globe about its center (a virtual trackball, as Google Earth does when a drag leaves the globe) and never runs off
   * its disc. Returns false when the center shows no globe.
   */
  pivotPan(dxPx: number, dyPx: number, widthPx: number, heightPx: number): boolean {
    const steps = Math.max(1, Math.ceil(Math.hypot(dxPx, dyPx) / PIVOT_STEP_PX));
    const center = this.pivot;
    for (let i = 0; i < steps; i++) {
      center.xPx = widthPx / 2;
      center.yPx = heightPx / 2;
      const anchor = this.navigation.grab(center);
      if (!anchor) return i > 0;
      center.xPx += dxPx / steps;
      center.yPx += dyPx / steps;
      this.navigation.dragTo(anchor, center);
    }
    return true;
  }

  /**
   * The factor that turns a pan velocity at `point`, along (dx, dy), into the velocity at the screen center that turns
   * the globe as fast (KB-202): near the globe's edge a pixel is a larger turn than at the center. 1 when either point
   * shows no globe.
   */
  pivotScale(point: ScreenPoint, dxPx: number, dyPx: number, widthPx: number, heightPx: number): number {
    const length = Math.hypot(dxPx, dyPx);
    if (length === 0) return 1;
    const ux = (PROBE_PX * dxPx) / length;
    const uy = (PROBE_PX * dyPx) / length;
    const at = this.turnPerPx(point.xPx, point.yPx, ux, uy);
    const center = this.turnPerPx(widthPx / 2, heightPx / 2, ux, uy);
    return at > 0 && center > 0 ? at / center : 1;
  }

  /** Radians the globe turns for a pixel of drag at (x, y) along (ux, uy) of {@link PROBE_PX}; 0 off the globe. */
  private turnPerPx(xPx: number, yPx: number, ux: number, uy: number): number {
    const probe = this.pivot;
    probe.xPx = xPx;
    probe.yPx = yPx;
    const a = this.navigation.grab(probe);
    probe.xPx = xPx + ux;
    probe.yPx = yPx + uy;
    let b = this.navigation.grab(probe);
    if (!b) {
      // At the very edge, the probe the other way.
      probe.xPx = xPx - ux;
      probe.yPx = yPx - uy;
      b = this.navigation.grab(probe);
    }
    return a && b ? angleRad(a, b) / PROBE_PX : 0;
  }

  /** Scratch point of the pivot pan and the probes. */
  private readonly pivot = { xPx: 0, yPx: 0 };

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

  /**
   * A smoothed zoom heads `levels` from the current view about `point` (F672): the view it will show loads ahead
   * ({@link NavigationApi.preloadView}), centered where a zoom on a flat map brings it, the position under the point
   * staying there; none once it has arrived (0).
   */
  zoomAhead(point: ScreenPoint, levels: number): void {
    const camera = this.globe?.camera;
    const at = levels !== 0 && camera ? this.navigation.grab(point) : undefined;
    const scale = 2 ** -levels;
    this.navigation.preloadView(
      at && camera
        ? {
            longitudeDeg: at.longitudeDeg + (((camera.longitudeDeg - at.longitudeDeg + 540) % 360) - 180) * scale,
            latitudeDeg: at.latitudeDeg + (camera.latitudeDeg - at.latitudeDeg) * scale,
            zoom: camera.zoom + levels,
          }
        : undefined,
    );
  }

  /** The applied heading, in degrees. */
  headingDeg(): number {
    return this.navigation.headingDeg;
  }

  /**
   * Rotates and tilts about the screen-center target: the target stays at the screen center, the range is kept, and
   * the new values become the chosen ones. The tilt is clamped to [0, maxTiltDeg].
   */
  rotate(deltaHeadingDeg: number, deltaTiltDeg: number, maxTiltDeg: number): void {
    // Beyond the tilt policy's lock the view stays flat (F625): gestures and keys turn it but do not tilt it.
    if (this.navigation.tiltPolicy?.[3] === 0) deltaTiltDeg = 0;
    if (deltaHeadingDeg === 0 && deltaTiltDeg === 0) return;
    const tilt = this.navigation.tiltDeg;
    const clamped = Math.min(Math.max(tilt + deltaTiltDeg, 0), maxTiltDeg) - tilt;
    this.navigation.orbit(deltaHeadingDeg, deltaTiltDeg === 0 ? 0 : clamped);
  }
}

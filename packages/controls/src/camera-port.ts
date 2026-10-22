import type { GeoPosition, Globe, NavigationApi, ScreenPoint } from '@vibeglobe/core';

/**
 * The part of the engine's public API the controls use beyond `NavigationApi`: the applied camera, the engine
 * clock and `jumpTo` for heading and tilt about the screen-center target. A temporary bridge until `NavigationApi`
 * carries these (hook request "M6 input" 1 and 2 in docs/parallel-tracks.md).
 */
export type ConnectedGlobe = Pick<Globe, 'camera' | 'timeMs' | 'jumpTo'> & {
  /** The home command (F194), used by the Home key when the engine has it. */
  goHome?(): unknown;
  /** The view-mode toggle (F163), used by the 2, 3 and A keys when the engine has it. */
  setViewMode?(mode: '2d' | '3d' | 'auto'): void;
};

/** Every camera change the recognizers make goes through here. */
export class CameraPort {
  globe: ConnectedGlobe | undefined;
  /** Engine time of the previous frame's update, where animations started since then begin. */
  previousFrameMs = NaN;
  private frameMs = NaN;
  private frameQueued = false;
  private readonly requestNow = (): void => {
    this.frameQueued = false;
    this.navigation.requestUpdate();
  };

  constructor(
    private readonly navigation: NavigationApi,
    private readonly hostNow: () => number,
  ) {}

  /** Engine time, which inertia and smoothing run on; the host clock until a globe is connected. */
  nowMs(): number {
    return this.globe ? this.globe.timeMs : this.hostNow();
  }

  /** Starts a frame's update; returns its engine time. */
  beginFrame(): number {
    const now = this.nowMs();
    this.previousFrameMs = Number.isNaN(this.frameMs) ? now : this.frameMs;
    this.frameMs = now;
    return now;
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

  /** {@link NavigationApi.zoomAt}, skipped for a zero step. */
  zoomAt(point: ScreenPoint, deltaZoom: number): void {
    if (deltaZoom !== 0) this.navigation.zoomAt(point, deltaZoom);
  }

  /** True when heading and tilt can change (a globe is connected). */
  get canRotate(): boolean {
    return this.globe !== undefined;
  }

  /** The applied heading and tilt, in degrees (0 before a globe is connected). */
  headingDeg(): number {
    return this.globe?.camera.headingDeg ?? 0;
  }

  /** The applied tilt in degrees. */
  tiltDeg(): number {
    return this.globe?.camera.tiltDeg ?? 0;
  }

  /**
   * Rotates and tilts about the screen-center target: the target stays at the screen center, the range is kept, and
   * the new values become the chosen ones. The tilt is clamped to [0, maxTiltDeg].
   */
  rotate(deltaHeadingDeg: number, deltaTiltDeg: number, maxTiltDeg: number): void {
    const globe = this.globe;
    if (!globe || (deltaHeadingDeg === 0 && deltaTiltDeg === 0)) return;
    const camera = globe.camera;
    const heading = (((camera.headingDeg + deltaHeadingDeg) % 360) + 360) % 360;
    const tilt = Math.min(Math.max(camera.tiltDeg + deltaTiltDeg, 0), maxTiltDeg);
    if (deltaTiltDeg === 0 || tilt === camera.tiltDeg) globe.jumpTo({ headingDeg: heading });
    else globe.jumpTo({ headingDeg: heading, tiltDeg: tilt });
  }
}

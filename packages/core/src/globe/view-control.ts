// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { Camera } from '../camera/camera.js';
import { northUpLimitRad } from '../camera/anchor.js';
import { validateViewCurves, type ViewCurvesInit } from '../view/curves.js';
import type { ViewState } from '../view/view-state.js';
import type { Emitter } from './emitter.js';
import { dragCamera, zoomCamera } from './navigation.hot.js';
import type { GeoPosition, GlobeEvents, NavigationApi, ScreenPoint } from './types.js';
import { isScreenPoint } from './validation.js';
import { positionAt } from './view-geometry.js';
import { ControlsSlot } from './controls-slot.js';

const RAD = Math.PI / 180;

/** How a drag moves the camera (see `NavigationApi.navigationMode`). */
export type NavigationMode = NonNullable<NavigationApi['navigationMode']>;

/** What the view API needs from its globe. */
export interface ViewHost {
  readonly cam: Camera;
  readonly view: ViewState;
  readonly emitter: Emitter<GlobeEvents>;
  /** True while there is no camera to draw or query (no viewport yet). */
  waiting(): boolean;
  assertAlive(): void;
  requestRender(): void;
  /** The user moved the camera through an intent: it interrupts a running movement (F202, ADR 0036). */
  userInput(cause: 'user' | 'inertia'): void;
  /** The engine clock's time, milliseconds. */
  timeMs(): number;
  /** Writes the engine clock's time to `out[0]` (F064). */
  timeInto(out: Float64Array): void;
  /** The part of a zoom step the zoom limits allow (KB-126). */
  limitZoom(deltaZoom: number): number;
  /** Whether zoom limits are set: without them a step goes through untouched, with no call (KB-132). */
  zoomLimited(): boolean;
  /** Stops a running API movement (KB-127). */
  interruptMovement(): void;
  /** Interrupts the running movement if it eases the tilt: a view mode chosen meanwhile takes over (KB-207). */
  interruptTilt(): void;
}

/**
 * The view modes, the curves and the input intents of a globe (F161–F164, ADR 0009): each change reaches the view
 * state, announces a mode change and asks for a frame.
 */
export class ViewControl {
  /** Input intents for the controls plug-in: invalid input is ignored, never thrown (they run every frame). */
  readonly navigation: NavigationApi;
  /** `requestUpdate` was called since the last {@link ViewControl.takeUpdateRequest}. */
  private updateRequested = false;
  /** See `NavigationApi.coasting`. */
  private coasting = false;
  /** The input plug-in, attached to the renderer's input element; API movements interrupt it (F202). */
  readonly slot = new ControlsSlot();

  constructor(private readonly host: ViewHost) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- the accessors below read this control
    const control = this;
    this.navigation = {
      grab: (point) => (isScreenPoint(point) ? this.positionAt(point) : undefined),
      dragTo: (anchor, point) => {
        if (!this.input()) return;
        if (dragCamera(host.cam, host.view, anchor, point, this.northUp())) host.requestRender();
      },
      zoomAt: (point, deltaZoom) => {
        if (!this.input()) return;
        const allowed =
          host.zoomLimited() && typeof deltaZoom === 'number' && Number.isFinite(deltaZoom)
            ? host.limitZoom(deltaZoom)
            : deltaZoom;
        if (zoomCamera(host.cam, host.view, point, allowed, this.northUp())) host.requestRender();
      },
      requestUpdate: () => {
        this.updateRequested = true;
        host.requestRender();
      },
      orbit: (deltaHeadingDeg, deltaTiltDeg) => this.orbit(deltaHeadingDeg, deltaTiltDeg),
      interruptMovement: () => {
        host.assertAlive();
        host.interruptMovement();
      },
      get coasting() {
        return control.coasting;
      },
      set coasting(value: boolean) {
        control.coasting = value === true;
      },
      // How a drag moves the camera: set by the controls, read by each drag and zoom below.
      navigationMode: 'free',
      get tiltPolicy() {
        return host.view.tiltPolicy;
      },
      get timeMs() {
        return host.timeMs();
      },
      timeInto: (out) => host.timeInto(out),
      get headingDeg() {
        return host.cam.pose.headingRad / RAD;
      },
      get tiltDeg() {
        return host.cam.pose.tiltRad / RAD;
      },
    };
  }

  /**
   * The position under a valid screen point as the frame shows it, on the terrain drawn when `heightAt` gives heights
   * (F383); none before the viewport has a size.
   */
  positionAt(
    point: ScreenPoint,
    heightAt?: (longitudeRad: number, latitudeRad: number) => number,
  ): GeoPosition | undefined {
    return this.host.waiting() ? undefined : positionAt(this.host.cam, this.host.view, point, heightAt);
  }

  /** Sets the view mode (F163), announcing a change. */
  setMode(mode: '2d' | '3d' | 'auto'): void {
    const view = this.host.view;
    const before = view.mode;
    view.setMode(mode);
    this.host.interruptTilt();
    if (view.mode !== before) this.host.emitter.emit('view-mode-change', { mode: view.mode });
    this.host.requestRender();
  }

  /** Validates and applies new zoom curves (F150); the view eases to them. */
  setCurves(curves: ViewCurvesInit): void {
    this.host.view.setCurves(validateViewCurves(curves));
    this.host.requestRender();
  }

  /** Runs the controls' update for this frame; a frame they ask for meanwhile is noted (M6 input hook 3). */
  updateControls(): void {
    this.updateRequested = false;
    this.slot.controls?.update?.();
  }

  /**
   * Whether the controls asked for a frame since the last call (in a frame: during their update, M6 input hook 3), and
   * clears the request.
   */
  takeUpdateRequest(): boolean {
    const requested = this.updateRequested;
    this.updateRequested = false;
    return requested;
  }

  /** Whether drags and zooms hold north up; if so, writes their latitude limit (`NavigationApi.northUpMaxLatitudeDeg`). */
  private northUp(): boolean {
    northUpLimitRad[0] = (this.navigation.northUpMaxLatitudeDeg ?? 85) * RAD;
    return this.navigation.navigationMode === 'north-up';
  }

  /** Starts a step of the user's input, or of its glide, unless the globe is waiting; false then. */
  private input(): boolean {
    this.host.assertAlive();
    if (this.host.waiting()) return false;
    this.host.userInput(this.coasting ? 'inertia' : 'user');
    return true;
  }

  /** See `NavigationApi.orbit`: invalid input is ignored. */
  private orbit(deltaHeadingDeg: number, deltaTiltDeg: number): void {
    const host = this.host;
    host.assertAlive();
    if (host.waiting() || !(deltaHeadingDeg - deltaHeadingDeg === 0 && deltaTiltDeg - deltaTiltDeg === 0)) return;
    if (deltaHeadingDeg === 0 && deltaTiltDeg === 0) return;
    host.userInput(this.coasting ? 'inertia' : 'user');
    const pose = host.cam.pose;
    const heading = pose.headingRad + deltaHeadingDeg * RAD;
    pose.headingRad = heading - 2 * Math.PI * Math.floor(heading / (2 * Math.PI));
    if (deltaTiltDeg !== 0) this.chooseTilt(Math.min(90, Math.max(0, pose.tiltRad / RAD + deltaTiltDeg)));
    host.cam.update();
    host.requestRender();
  }

  /** A view given with a tilt chooses it: manual mode (ADR 0034). */
  chooseTilt(tiltDeg: number): void {
    const view = this.host.view;
    const manual = view.mode === 'manual';
    view.chooseTilt(tiltDeg * RAD);
    if (!manual) this.host.emitter.emit('view-mode-change', { mode: 'manual' });
  }
}

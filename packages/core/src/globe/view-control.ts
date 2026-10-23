import type { Camera } from '../camera/camera.js';
import { validateViewCurves, type ViewCurvesInit } from '../view/curves.js';
import type { ViewState } from '../view/view-state.js';
import type { Emitter } from './emitter.js';
import { dragCamera, zoomCamera } from './navigation.hot.js';
import type { GeoPosition, GlobeEvents, NavigationApi, ScreenPoint } from './types.js';
import { isScreenPoint } from './validation.js';
import { positionAt } from './view-geometry.js';

const RAD = Math.PI / 180;

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
  userInput(): void;
}

/**
 * The view modes, the curves and the input intents of a globe (F161–F164, ADR 0009): each change reaches the view
 * state, announces a mode change and asks for a frame.
 */
export class ViewControl {
  /** Input intents for the controls plug-in: invalid input is ignored, never thrown (they run every frame). */
  readonly navigation: NavigationApi;

  constructor(private readonly host: ViewHost) {
    this.navigation = {
      grab: (point) => (isScreenPoint(point) ? this.positionAt(point) : undefined),
      dragTo: (anchor, point) => {
        host.assertAlive();
        if (host.waiting()) return;
        host.userInput();
        if (dragCamera(host.cam, host.view, anchor, point)) host.requestRender();
      },
      zoomAt: (point, deltaZoom) => {
        host.assertAlive();
        if (host.waiting()) return;
        host.userInput();
        if (zoomCamera(host.cam, host.view, point, deltaZoom)) host.requestRender();
      },
      requestUpdate: () => host.requestRender(),
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
    if (view.mode !== before) this.host.emitter.emit('view-mode-change', { mode: view.mode });
    this.host.requestRender();
  }

  /** Validates and applies new zoom curves (F150); the view eases to them. */
  setCurves(curves: ViewCurvesInit): void {
    this.host.view.setCurves(validateViewCurves(curves));
    this.host.requestRender();
  }

  /** A view given with a tilt chooses it: manual mode (ADR 0034). */
  chooseTilt(tiltDeg: number): void {
    const view = this.host.view;
    const manual = view.mode === 'manual';
    view.chooseTilt(tiltDeg * RAD);
    if (!manual) this.host.emitter.emit('view-mode-change', { mode: 'manual' });
  }
}

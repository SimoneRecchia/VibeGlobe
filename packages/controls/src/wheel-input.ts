// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { MutablePoint } from './animators.js';
import type { GestureContext } from './gesture-context.js';

const LINE_HEIGHT_PX = 16;
/** Whole-pixel deltas at least this large come from a notched wheel (ADR 0009 §4). */
const NOTCH_MIN_PX = 50;

/** A wheel event's fields, at a canvas position. */
export interface WheelInputEvent {
  readonly xPx: number;
  readonly yPx: number;
  readonly deltaY: number;
  readonly deltaMode: number;
  readonly ctrlKey: boolean;
}

/**
 * Wheel and trackpad zoom (F168, F169; ADR 0009 §4): one mapping, Δzoom = −Δy / 300 (line and page deltas in pixels),
 * and −Δy / 100 for a trackpad pinch (`ctrlKey` without the Ctrl key held). Notch-like events are smoothed into the
 * shared zoom target (τ 100 ms, leading the camera by at most 2 levels); trackpad deltas apply in the next frame,
 * summed, so the zoom follows the fingers without stepping. Safari's trackpad gesture events pinch and rotate.
 */
export class WheelInput {
  private immediate = 0;
  private readonly at: MutablePoint = { xPx: 0, yPx: 0 };
  /** True while the physical Ctrl key is down (a pinch reports `ctrlKey` without it). */
  ctrlHeld = false;
  private gestureScale = 1;
  private gestureRotationDeg = 0;
  private headingDeg = 0;

  constructor(private readonly context: GestureContext) {}

  /** Records a wheel event; returns whether a frame is needed. */
  wheel(event: WheelInputEvent, pageHeightPx: number): boolean {
    const { options, zoom, inertia } = this.context;
    if (!options.gestures.wheelZoom) return false;
    const scale = event.deltaMode === 1 ? LINE_HEIGHT_PX : event.deltaMode === 2 ? pageHeightPx : 1;
    const deltaPx = event.deltaY * scale;
    const pinch = event.ctrlKey && !this.ctrlHeld;
    const levels = -deltaPx / (pinch ? options.wheel.pinchPixelsPerLevel : options.wheel.pixelsPerLevel);
    inertia.stop();
    const notch =
      !pinch && (event.deltaMode !== 0 || (Number.isInteger(event.deltaY) && Math.abs(event.deltaY) >= NOTCH_MIN_PX));
    if (notch) {
      zoom.add(levels, event.xPx, event.yPx, options.wheel.notchSmoothingMs, options.wheel.maxLeadLevels);
    } else {
      zoom.stop();
      this.immediate += levels;
      this.at.xPx = event.xPx;
      this.at.yPx = event.yPx;
    }
    return true;
  }

  /** Safari's `gesturestart`: a trackpad pinch or rotation begins. */
  gestureStart(): void {
    this.gestureScale = 1;
    this.gestureRotationDeg = 0;
  }

  /** Safari's `gesturechange` at a canvas position; returns whether a frame is needed. */
  gestureChange(scale: number, rotationDeg: number, xPx: number, yPx: number): boolean {
    const { options } = this.context;
    if (!(scale > 0)) return false;
    if (options.gestures.wheelZoom) this.immediate += Math.log2(scale / this.gestureScale);
    if (options.gestures.touchRotate) this.headingDeg -= rotationDeg - this.gestureRotationDeg;
    this.gestureScale = scale;
    this.gestureRotationDeg = rotationDeg;
    this.at.xPx = xPx;
    this.at.yPx = yPx;
    return true;
  }

  /** Applies the trackpad zoom recorded since the last frame. */
  apply(): void {
    const { port, options } = this.context;
    if (this.headingDeg !== 0) {
      port.rotate(this.headingDeg, 0, options.maxTiltDeg);
      this.headingDeg = 0;
    }
    if (this.immediate === 0) return;
    const levels = this.immediate;
    this.immediate = 0;
    port.zoomAt(this.at, levels);
  }
}

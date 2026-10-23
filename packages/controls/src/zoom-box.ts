import type { GeoPosition } from '@vibeglobe/core';
import type { MutablePoint } from './animators.js';
import type { CameraPort } from './camera-port.js';

/** Boxes smaller than this on either side do nothing. */
const MIN_BOX_PX = 4;

/** Smoothstep easing: zero speed at both ends. */
function ease(s: number): number {
  return s * s * (3 - 2 * s);
}

/** Longitude `lonDeg` unwrapped to within 180° of `nearDeg`. */
function unwrap(lonDeg: number, nearDeg: number): number {
  return nearDeg + ((((lonDeg - nearDeg + 180) % 360) + 360) % 360) - 180;
}

/**
 * The Shift+drag zoom box (F175): a dashed rectangle while dragging; on release the view eases so the box's center
 * comes to the screen center and the box fills the viewport in its limiting dimension. Escape cancels it. With a
 * connected globe the engine fits the box's geographic corners (`Globe.fitBounds`), so they stay inside the viewport
 * when the projection changes on the way (the globe flattening into the map); otherwise the box zooms by its pixel
 * ratio about its center.
 */
export class ZoomBox {
  private overlay: HTMLElement | undefined;
  private readonly start: MutablePoint = { xPx: 0, yPx: 0 };
  private readonly end: MutablePoint = { xPx: 0, yPx: 0 };
  private anchor: GeoPosition | undefined;
  private readonly from: MutablePoint = { xPx: 0, yPx: 0 };
  private readonly to: MutablePoint = { xPx: 0, yPx: 0 };
  private readonly pixel: MutablePoint = { xPx: 0, yPx: 0 };
  private levels = 0;
  private durationMs = 1;
  private startMs = NaN;
  private progress = 0;
  /** True while the fit animation runs. */
  fitting = false;

  constructor(private readonly element: HTMLElement) {}

  /** True while a box is being dragged. */
  get drawing(): boolean {
    return this.overlay !== undefined;
  }

  /** Starts a box at a canvas point. */
  begin(xPx: number, yPx: number): void {
    this.start.xPx = this.end.xPx = xPx;
    this.start.yPx = this.end.yPx = yPx;
    const overlay = this.element.ownerDocument.createElement('div');
    overlay.dataset['vibeglobeZoomBox'] = '';
    overlay.style.cssText =
      'position:fixed;pointer-events:none;box-sizing:border-box;border:2px dashed #fff;' +
      'background:rgba(255,255,255,0.15);outline:1px solid rgba(0,0,0,0.5);z-index:2147483647';
    this.element.ownerDocument.body.append(overlay);
    this.overlay = overlay;
    this.draw();
  }

  /** Moves the box's free corner. */
  update(xPx: number, yPx: number): void {
    this.end.xPx = xPx;
    this.end.yPx = yPx;
    this.draw();
  }

  private draw(): void {
    if (!this.overlay) return;
    const rect = this.element.getBoundingClientRect();
    const style = this.overlay.style;
    style.left = `${rect.left + Math.min(this.start.xPx, this.end.xPx)}px`;
    style.top = `${rect.top + Math.min(this.start.yPx, this.end.yPx)}px`;
    style.width = `${Math.abs(this.end.xPx - this.start.xPx)}px`;
    style.height = `${Math.abs(this.end.yPx - this.start.yPx)}px`;
  }

  /** Removes the box without moving anything (Escape). */
  cancel(): void {
    this.overlay?.remove();
    this.overlay = undefined;
  }

  /** Releases the box: starts the fit unless it is too small. */
  finish(port: CameraPort, widthPx: number, heightPx: number, durationMs: number): void {
    this.cancel();
    const boxWidth = Math.abs(this.end.xPx - this.start.xPx);
    const boxHeight = Math.abs(this.end.yPx - this.start.yPx);
    if (boxWidth < MIN_BOX_PX || boxHeight < MIN_BOX_PX || widthPx <= 0 || heightPx <= 0) return;
    this.from.xPx = (this.start.xPx + this.end.xPx) / 2;
    this.from.yPx = (this.start.yPx + this.end.yPx) / 2;
    this.anchor = port.grab(this.from);
    if (!this.anchor) return;
    if (this.fitCorners(port, durationMs, this.anchor.longitudeDeg)) return;
    this.to.xPx = widthPx / 2;
    this.to.yPx = heightPx / 2;
    this.levels = Math.log2(Math.min(widthPx / boxWidth, heightPx / boxHeight));
    this.durationMs = durationMs;
    this.startMs = NaN;
    this.progress = 0;
    this.fitting = true;
  }

  /** Asks the connected engine to fit the box's geographic corners; false when it cannot (no globe, a corner off it). */
  private fitCorners(port: CameraPort, durationMs: number, centerLonDeg: number): boolean {
    const fitBounds = port.globe?.fitBounds;
    if (!fitBounds) return false;
    let west = Infinity;
    let east = -Infinity;
    let south = Infinity;
    let north = -Infinity;
    for (const xPx of [this.start.xPx, this.end.xPx]) {
      for (const yPx of [this.start.yPx, this.end.yPx]) {
        const corner = port.grab({ xPx, yPx });
        if (!corner) return false;
        const lon = unwrap(corner.longitudeDeg, centerLonDeg);
        west = Math.min(west, lon);
        east = Math.max(east, lon);
        south = Math.min(south, corner.latitudeDeg);
        north = Math.max(north, corner.latitudeDeg);
      }
    }
    const bounds = { westDeg: unwrap(west, 0), eastDeg: unwrap(east, 0), southDeg: south, northDeg: north };
    fitBounds.call(port.globe, bounds, { movement: 'ease', durationMs });
    return true;
  }

  /** Stops the fit where it is. */
  stop(): void {
    this.fitting = false;
    this.anchor = undefined;
  }

  /** Advances the fit to `nowMs`; returns whether it continues. */
  step(nowMs: number, port: CameraPort): boolean {
    const anchor = this.anchor;
    if (!this.fitting || !anchor) return false;
    if (Number.isNaN(this.startMs)) this.startMs = nowMs;
    const s = ease(Math.min(1, (nowMs - this.startMs) / this.durationMs));
    if (s === this.progress) return true;
    // Zoom about where the anchor shows now, then carry it toward the center: both are eased by the same progress.
    this.pixel.xPx = this.from.xPx + (this.to.xPx - this.from.xPx) * this.progress;
    this.pixel.yPx = this.from.yPx + (this.to.yPx - this.from.yPx) * this.progress;
    port.zoomAt(this.pixel, this.levels * (s - this.progress));
    this.progress = s;
    this.pixel.xPx = this.from.xPx + (this.to.xPx - this.from.xPx) * s;
    this.pixel.yPx = this.from.yPx + (this.to.yPx - this.from.yPx) * s;
    port.dragTo(anchor, this.pixel);
    if (s === 1) this.stop();
    return this.fitting;
  }
}

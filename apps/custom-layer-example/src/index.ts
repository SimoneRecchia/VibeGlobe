/**
 * A layer type written by an application, outside the engine's packages, against the public layer plug-in interface
 * only (F388): beacons. It draws through the render target it is given, reserves pick ids so picking and pointer events
 * return its beacons, and follows the frames (clock and camera zoom) the stack passes it.
 */
import type { BatchHandle, GeoPosition } from '@vibeglobe/core';
import {
  LayerEmitter,
  ORDER_STRIDE,
  packPickId,
  type FrameContext,
  type Layer,
  type LayerContext,
} from '@vibeglobe/layers';

/** A beacon: an id and where it stands. */
export interface Beacon {
  readonly id: string;
  readonly position: GeoPosition;
}

/** Beacons: magenta circles whose radius follows the camera's zoom (4 px plus one per zoom level, at most 16). */
export class BeaconLayer extends LayerEmitter implements Layer {
  readonly id: string;
  /** Frames received, and the last frame's time and zoom (what the layer saw of the camera). */
  frames = 0;
  lastTimeMs = Number.NaN;
  lastZoom = Number.NaN;
  readonly #beacons: readonly Beacon[];
  #context: LayerContext | undefined;
  #handle: BatchHandle | undefined;
  #slot = 0;
  readonly #sizes: Float64Array;
  #radiusPx = Number.NaN;

  constructor(id: string, beacons: readonly Beacon[]) {
    super();
    this.id = id;
    this.#beacons = beacons;
    this.#sizes = new Float64Array(beacons.length);
  }

  /** Creates the batch and writes the beacons' positions, colors and pick ids. */
  attach(context: LayerContext): void {
    this.#context = context;
    this.#slot = context.acquirePickSlot((index) => {
      const beacon = this.#beacons[index];
      return beacon ? { layerId: this.id, id: beacon.id, properties: {} } : undefined;
    });
    const count = this.#beacons.length;
    const target = context.target;
    const handle = target.createBatch({
      kind: 'point',
      layerId: this.id,
      capacity: count,
      placement: 'clamp-to-ground',
    });
    this.#handle = handle;
    const positions = new Float64Array(count * 3);
    const colors = new Float64Array(count * 4);
    const ids = new Float64Array(count);
    const ones = new Float64Array(count).fill(1);
    for (const [i, beacon] of this.#beacons.entries()) {
      positions.set(
        [beacon.position.longitudeDeg, beacon.position.latitudeDeg, beacon.position.heightMeters ?? 0],
        i * 3,
      );
      colors.set([1, 0, 1, 1], i * 4);
      ids[i] = packPickId(this.#slot, i);
    }
    target.writeRange(handle, 'position', 0, count, positions);
    target.writeRange(handle, 'color', 0, count, colors);
    target.writeRange(handle, 'pickId', 0, count, ids);
    target.writeRange(handle, 'visible', 0, count, ones);
    target.writeRange(handle, 'opacity', 0, count, ones);
    target.setCount(handle, count);
    context.requestFrame();
  }

  /** Releases the batch and the pick slot. */
  detach(): void {
    if (this.#context && this.#handle) this.#context.target.release(this.#handle);
    if (this.#context) this.#context.releasePickSlot(this.#slot);
    this.#context = undefined;
    this.#handle = undefined;
  }

  /** Draws at `order` among the layers. */
  setOrder(order: number): void {
    if (this.#context && this.#handle) this.#context.target.setOrder(this.#handle, order * ORDER_STRIDE);
  }

  /** Shows or hides the beacons. */
  setVisible(visible: boolean): void {
    if (this.#context && this.#handle) this.#context.target.setVisible(this.#handle, visible);
    this.#context?.requestFrame();
  }

  /** Records the frame, and sizes the beacons by the zoom, writing only when the radius changes. */
  frame(frame: FrameContext): void {
    this.frames += 1;
    this.lastTimeMs = frame.nowMs;
    this.lastZoom = frame.zoom;
    const radiusPx = Math.min(16, 4 + Math.floor(frame.zoom));
    if (!this.#context || !this.#handle || radiusPx === this.#radiusPx) return;
    this.#radiusPx = radiusPx;
    this.#sizes.fill(radiusPx);
    this.#context.target.writeRange(this.#handle, 'sizePx', 0, this.#sizes.length, this.#sizes);
  }
}

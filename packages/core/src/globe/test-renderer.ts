// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { DecodedTile } from '../scheduler/types.js';
import type { TileMeshData } from '../surface/surface-mesh.js';
import type {
  FrameCapture,
  FrameView,
  RendererBackend,
  RendererCapabilities,
  RendererEvents,
  RendererFactory,
  RendererStats,
  RenderHost,
  ResourceCounts,
  TileDrawList,
} from './types.js';

/** A renderer and host for unit tests: frames run when `flush` is called. It allocates nothing per frame itself. */
export interface FakeRenderer extends RendererBackend {
  readonly meshes: Map<number, TileMeshData>;
  /** The host's clock and timers, advanced by the test. */
  readonly timers: FakeTimers;
  /** Uploaded imagery textures by handle. */
  readonly textures: Map<number, DecodedTile>;
  /** The draw list of the last drawn frame (the engine's own, reused every frame). */
  lastDraws: TileDrawList | undefined;
  /** The element the controls attach to; a recovery may replace it. */
  inputElement: unknown;
  /** Frames drawn so far. */
  drawCount: number;
  /** Whether `render` draws; false stands for a renderer that is recovering and skips frames. */
  drawing: boolean;
  /** Tiles in the last drawn frame. */
  lastTiles: number;
  /** Debug meshes last handed to the renderer. */
  debugMeshes: number;
  events: RendererEvents | undefined;
  visibility: ((visible: boolean) => void) | undefined;
  resizeListener: (() => void) | undefined;
  size: { widthPx: number; heightPx: number };
  /** Set to make the host report the current size only when the engine checks at the start of a frame. */
  unreportedResize: boolean;
  /** The size of the last resize. */
  lastResize: { widthPx: number; heightPx: number } | undefined;
  /** The drawing buffer of the last resize, in device pixels (CSS size times pixel ratio, rounded down). */
  bufferPx: { widthPx: number; heightPx: number } | undefined;
  destroyed: boolean;
  /** Runs pending frame callbacks; returns how many ran. */
  flush(): number;
}

const FAKE_CAPABILITIES: RendererCapabilities = {
  backend: 'webgl2',
  maxTextureSize: 4096,
  maxAnisotropy: 1,
  compressedTextureFormats: [],
  deviceMemoryGiB: undefined,
  adapter: 'fake',
  depthPath: 'reversed-z',
  depthFormat: 'depth32float',
};

/** Creates a fake renderer and the factory that hands it to createGlobe. */
export function fakeRenderer(): { renderer: FakeRenderer; factory: RendererFactory } {
  const pending = new FrameQueue();
  const host = fakeHost(pending, () => renderer);
  const renderer: FakeRenderer = {
    capabilities: FAKE_CAPABILITIES,
    host,
    inputElement: {},
    meshes: new Map(),
    timers: new FakeTimers(),
    textures: new Map(),
    lastDraws: undefined,
    drawCount: 0,
    drawing: true,
    lastTiles: 0,
    debugMeshes: 0,
    events: undefined,
    visibility: undefined,
    resizeListener: undefined,
    size: { widthPx: 800, heightPx: 600 },
    unreportedResize: false,
    lastResize: undefined,
    bufferPx: undefined,
    destroyed: false,
    addMesh: (mesh) => void renderer.meshes.set(mesh.key, mesh),
    removeMesh: (key) => void renderer.meshes.delete(key),
    setBaseImagery: () => Promise.resolve(),
    uploadTexture: (handle, tile) => void renderer.textures.set(handle, tile),
    releaseTexture: (handle) => void renderer.textures.delete(handle),
    render: (_view: FrameView, draws: TileDrawList) => {
      if (!renderer.drawing) return false;
      renderer.drawCount++;
      renderer.lastTiles = draws.count;
      renderer.lastDraws = draws;
      return true;
    },
    resize: (widthPx: number, heightPx: number, pixelRatio: number) => {
      renderer.lastResize = { widthPx, heightPx };
      renderer.bufferPx = { widthPx: Math.floor(widthPx * pixelRatio), heightPx: Math.floor(heightPx * pixelRatio) };
    },
    setDebugMeshes: (meshes) => void (renderer.debugMeshes = meshes.length),
    stats: () => fakeStats(renderer),
    resourceCounts: () => fakeCounts(renderer),
    simulateDeviceLoss: () => renderer.events?.deviceLost('simulated'),
    capture: () => Promise.resolve(blankFrame(renderer.bufferPx ?? renderer.size)),
    destroy: () => {
      renderer.destroyed = true;
    },
    flush: () => {
      return pending.run();
    },
  };
  const factory: RendererFactory = (_container, events) => {
    renderer.events = events;
    return Promise.resolve(renderer);
  };
  return { renderer, factory };
}

/** A host whose frames run only when the test flushes them. */
function fakeHost(pending: FrameQueue, renderer: () => FakeRenderer): RenderHost {
  let nextId = 1;
  return {
    requestFrame: (callback) => {
      pending.add(nextId, callback);
      return nextId++;
    },
    cancelFrame: (id) => pending.cancel(id),
    now: () => renderer().timers.nowMs,
    setTimer: (callback, delayMs) => renderer().timers.set(callback, delayMs),
    clearTimer: (handle) => renderer().timers.clear(handle),
    observeSize: (callback) => {
      renderer().resizeListener = callback;
      return () => (renderer().resizeListener = undefined);
    },
    observeVisibility: (callback) => {
      renderer().visibility = callback;
      return () => (renderer().visibility = undefined);
    },
    checkSize: () => {
      if (!renderer().unreportedResize) return;
      renderer().unreportedResize = false;
      renderer().resizeListener?.();
    },
    containerSize: () => renderer().size,
    pixelRatio: () => 1,
  };
}

/**
 * Frame timestamps as a browser hands them to animation-frame callbacks: fractional milliseconds, already heap numbers.
 * The array holds tagged values (the leading null keeps it from storing raw doubles), so passing one allocates nothing.
 */
const STAMPS: unknown[] = [null, ...Array.from({ length: 4096 }, (_, i) => 1000.25 + i * (1000 / 60))];

/** Pending frame callbacks in reused arrays (a Map's clear() allocates a new table), so the test double allocates nothing. */
class FrameQueue {
  private readonly ids: number[] = [];
  private readonly callbacks: ((timeMs: number) => void)[] = [];
  private readonly running: ((timeMs: number) => void)[] = [];
  private count = 0;
  private stamp = 1;

  /** Queues a callback under an id. */
  add(id: number, callback: (timeMs: number) => void): void {
    this.ids[this.count] = id;
    this.callbacks[this.count] = callback;
    this.count++;
  }

  /** Removes the callback with this id, if queued. */
  cancel(id: number): void {
    for (let i = 0; i < this.count; i++) {
      if (this.ids[i] !== id) continue;
      this.count--;
      this.ids[i] = this.ids[this.count] ?? 0;
      const last = this.callbacks[this.count];
      if (last) this.callbacks[i] = last;
      return;
    }
  }

  /** Runs the queued callbacks; ones queued while running wait for the next run. Returns how many ran. */
  run(): number {
    const count = this.count;
    for (let i = 0; i < count; i++) {
      const callback = this.callbacks[i];
      if (callback) this.running[i] = callback;
    }
    this.count = 0;
    const timeMs = STAMPS[this.stamp] as number;
    this.stamp = this.stamp + 1 < STAMPS.length ? this.stamp + 1 : 1;
    for (let i = 0; i < count; i++) this.running[i]?.(timeMs);
    return count;
  }
}

/** A transparent frame of the given size: the fake renderer draws nothing. */
function blankFrame(size: { widthPx: number; heightPx: number }): FrameCapture {
  return { ...size, rgba: new Uint8ClampedArray(size.widthPx * size.heightPx * 4) };
}

/** The fake renderer's counters: one draw call per frame, nothing else measured. */
function fakeStats(renderer: FakeRenderer): RendererStats {
  return {
    drawCalls: renderer.drawCount,
    triangles: 0,
    textureUploads: 1,
    meshUploads: 1,
    matrixUpdates: 0,
    pipelineCompiles: 0,
    pipelineSwitches: 0,
    compressedTextures: 0,
    gpuFrameMs: null,
  };
}

/** Resource counts of the fake renderer: its meshes and textures, the base image and one context until destroyed. */
function fakeCounts(renderer: FakeRenderer): ResourceCounts {
  const held = renderer.destroyed ? 0 : 1;
  return {
    meshes: renderer.meshes.size,
    textures: held + renderer.textures.size,
    gpuBytes: 0,
    vertexArrays: 0,
    contexts: held,
  };
}

/** A manual clock with timers: `advance` moves time and runs the timers that came due, in order. */
export class FakeTimers {
  nowMs = 0;
  private readonly pending = new Map<number, { atMs: number; callback: () => void }>();
  private nextId = 1;

  /** Calls `callback` once after `delayMs`. */
  set(callback: () => void, delayMs: number): number {
    const id = this.nextId++;
    this.pending.set(id, { atMs: this.nowMs + Math.max(0, delayMs), callback });
    return id;
  }

  /** Cancels a timer. */
  clear(handle: unknown): void {
    this.pending.delete(handle as number);
  }

  /** Moves the clock forward by `ms`, running every timer that comes due. */
  advance(ms: number): void {
    const end = this.nowMs + ms;
    for (;;) {
      let next: [number, { atMs: number; callback: () => void }] | undefined;
      for (const entry of this.pending)
        if (entry[1].atMs <= end && (!next || entry[1].atMs < next[1].atMs)) next = entry;
      if (!next) break;
      this.pending.delete(next[0]);
      this.nowMs = next[1].atMs;
      next[1].callback();
    }
    this.nowMs = end;
  }
}

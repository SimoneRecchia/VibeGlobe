import type { TileMeshData } from '../surface/surface-mesh.js';
import type {
  FrameView,
  RendererBackend,
  RendererCapabilities,
  RendererEvents,
  RendererFactory,
  RenderHost,
} from './types.js';

/** A renderer and host for unit tests: frames run when `flush` is called. It allocates nothing per frame itself. */
export interface FakeRenderer extends RendererBackend {
  readonly meshes: Map<number, TileMeshData>;
  /** The element the controls attach to; a recovery may replace it. */
  inputElement: unknown;
  /** Frames drawn so far. */
  drawCount: number;
  /** Tiles in the last drawn frame. */
  lastTiles: number;
  events: RendererEvents | undefined;
  visibility: ((visible: boolean) => void) | undefined;
  resizeListener: (() => void) | undefined;
  size: { widthPx: number; heightPx: number };
  /** Set to make the host report the current size only when the engine checks at the start of a frame. */
  unreportedResize: boolean;
  /** The size of the last resize. */
  lastResize: { widthPx: number; heightPx: number } | undefined;
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
    drawCount: 0,
    lastTiles: 0,
    events: undefined,
    visibility: undefined,
    resizeListener: undefined,
    size: { widthPx: 800, heightPx: 600 },
    unreportedResize: false,
    lastResize: undefined,
    destroyed: false,
    addMesh: (mesh) => void renderer.meshes.set(mesh.key, mesh),
    removeMesh: (key) => void renderer.meshes.delete(key),
    setBaseImagery: () => Promise.resolve(),
    render: (_view: FrameView, _keys: readonly number[], count: number) => {
      renderer.drawCount++;
      renderer.lastTiles = count;
    },
    resize: (widthPx: number, heightPx: number) => {
      renderer.lastResize = { widthPx, heightPx };
    },
    setDebugMeshes: () => undefined,
    stats: () => ({
      drawCalls: renderer.drawCount,
      triangles: 0,
      textureUploads: 1,
      matrixUpdates: 0,
      pipelineCompiles: 0,
    }),
    resourceCounts: () => ({
      meshes: renderer.meshes.size,
      textures: renderer.destroyed ? 0 : 1,
      gpuBytes: 0,
      vertexArrays: 0,
      contexts: renderer.destroyed ? 0 : 1,
    }),
    simulateDeviceLoss: () => renderer.events?.deviceLost('simulated'),
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
    now: () => 0,
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

/** Pending frame callbacks in reused arrays (a Map's clear() allocates a new table), so the test double allocates nothing. */
class FrameQueue {
  private readonly ids: number[] = [];
  private readonly callbacks: ((timeMs: number) => void)[] = [];
  private readonly running: ((timeMs: number) => void)[] = [];
  private count = 0;

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
    for (let i = 0; i < count; i++) this.running[i]?.(0);
    return count;
  }
}

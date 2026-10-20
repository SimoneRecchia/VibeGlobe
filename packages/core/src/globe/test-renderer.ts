import type { TileMeshData } from '../surface/surface-mesh.js';
import type { FrameView, RendererBackend, RendererEvents, RendererFactory, RenderHost } from './types.js';

/** A renderer and host for unit tests: frames run when `flush` is called, draws are recorded. */
export interface FakeRenderer extends RendererBackend {
  readonly meshes: Map<number, TileMeshData>;
  readonly draws: number[];
  events: RendererEvents | undefined;
  visibility: ((visible: boolean) => void) | undefined;
  resizeListener: (() => void) | undefined;
  size: { widthPx: number; heightPx: number };
  destroyed: boolean;
  /** Runs pending frame callbacks; returns how many ran. */
  flush(): number;
}

/** Creates a fake renderer and the factory that hands it to createGlobe. */
export function fakeRenderer(): { renderer: FakeRenderer; factory: RendererFactory } {
  const pending = new Map<number, (timeMs: number) => void>();
  const host = fakeHost(pending, () => renderer);
  const renderer: FakeRenderer = {
    capabilities: {
      backend: 'webgl2',
      maxTextureSize: 4096,
      maxAnisotropy: 1,
      compressedTextureFormats: [],
      deviceMemoryGiB: undefined,
      adapter: 'fake',
    },
    host,
    inputElement: {},
    meshes: new Map(),
    draws: [],
    events: undefined,
    visibility: undefined,
    resizeListener: undefined,
    size: { widthPx: 800, heightPx: 600 },
    destroyed: false,
    addMesh: (mesh) => void renderer.meshes.set(mesh.key, mesh),
    removeMesh: (key) => void renderer.meshes.delete(key),
    setBaseImagery: () => Promise.resolve(),
    render: (_view: FrameView, _keys: readonly number[], count: number) => void renderer.draws.push(count),
    resize: () => undefined,
    setDebugMeshes: () => undefined,
    stats: () => ({ drawCalls: renderer.draws.length, triangles: 0, textureUploads: 1, matrixUpdates: 0 }),
    resourceCounts: () => ({
      meshes: renderer.destroyed ? 0 : renderer.meshes.size,
      textures: renderer.destroyed ? 0 : 1,
      gpuBytes: 0,
    }),
    simulateDeviceLoss: () => renderer.events?.deviceLost('simulated'),
    destroy: () => {
      renderer.destroyed = true;
    },
    flush: () => {
      const callbacks = [...pending.values()];
      pending.clear();
      for (const callback of callbacks) callback(0);
      return callbacks.length;
    },
  };
  const factory: RendererFactory = (_container, events) => {
    renderer.events = events;
    return Promise.resolve(renderer);
  };
  return { renderer, factory };
}

/** A host whose frames run only when the test flushes them. */
function fakeHost(pending: Map<number, (timeMs: number) => void>, renderer: () => FakeRenderer): RenderHost {
  let nextId = 1;
  return {
    requestFrame: (callback) => {
      pending.set(nextId, callback);
      return nextId++;
    },
    cancelFrame: (id) => pending.delete(id),
    now: () => 0,
    observeSize: (callback) => {
      renderer().resizeListener = callback;
      return () => (renderer().resizeListener = undefined);
    },
    observeVisibility: (callback) => {
      renderer().visibility = callback;
      return () => (renderer().visibility = undefined);
    },
    containerSize: () => renderer().size,
    pixelRatio: () => 1,
  };
}

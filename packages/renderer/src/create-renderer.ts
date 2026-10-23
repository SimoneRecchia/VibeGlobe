import type { GltfLoaderFactory } from './layer-models.js';
import { GlobeError, type RendererFactory, type RenderHost } from '@vibeglobe/core';
import type { BackendChoice, DepthChoice } from './three-backend.js';

/** Options of {@link createRenderer}. */
export interface RendererOptions {
  /** 'auto' (default) uses WebGPU and falls back to WebGL2; 'webgpu' or 'webgl2' force a backend. */
  readonly backend?: BackendChoice;
  /**
   * 'auto' (default) uses hardware reversed-Z wherever it exists; 'fragment' forces the depth path of WebGL2 without
   * `EXT_clip_control` (ADR 0005), for tests and diagnostics. WebGPU ignores it.
   */
  readonly depth?: DepthChoice;
  /**
   * The canvas to draw into: a canvas inside the container (by default the renderer creates one), or an OffscreenCanvas,
   * for example in a worker (ADR 0011). An OffscreenCanvas needs `host`. A page canvas is styled to fill the container.
   * After a device loss, or when an earlier globe left the canvas with a context this renderer cannot use (a released
   * WebGL2 context, or the other backend's), a new canvas with the same id, class and ARIA attributes takes its place.
   */
  readonly canvas?: HTMLCanvasElement | OffscreenCanvas;
  /**
   * Frames, size, pixel ratio and visibility where there is no page to observe (with an OffscreenCanvas); in a page the
   * renderer observes the container itself.
   */
  readonly host?: RenderHost;
  /**
   * Measures each frame's GPU time with timestamp queries where the device offers them, reported as
   * `RendererStats.gpuFrameMs` (default false). For benchmarks: reading the queries back allocates every frame.
   */
  readonly gpuTiming?: boolean;
  /**
   * Limits the compressed texture families KTX2 imagery may use to these ('bc', 'etc2', 'astc'), among those the device
   * decodes (default: all of them; [] forces RGBA8). For tests, and for drivers that emulate a family (ADR 0020).
   */
  readonly compressedTextures?: readonly string[];
  /** The glTF loader for `Globe.addModel` (F361): `gltfLoader` from `@vibeglobe/renderer/gltf`; without it, no models. */
  readonly gltf?: GltfLoaderFactory;
}

/**
 * Creates the renderer plug-in for `createGlobe` (ADR 0010): three.js WebGPURenderer with an automatic WebGL2 fallback.
 * three.js is loaded only when the globe starts (it writes to `window` when imported), so importing this package is
 * SSR-safe and costs no rendering code until a globe exists.
 */
export function createRenderer(options: RendererOptions = {}): RendererFactory {
  const settings = {
    choice: options.backend ?? 'auto',
    depth: options.depth ?? 'auto',
    gpuTiming: options.gpuTiming ?? false,
    compressedTextures: options.compressedTextures,
  } as const;
  return async (container, events) => {
    const canvas = options.canvas;
    const offscreen = typeof OffscreenCanvas !== 'undefined' && canvas instanceof OffscreenCanvas;
    const [{ ThreeBackend }, hostModule] = await Promise.all([
      import('./three-backend.js'),
      offscreen ? undefined : import('./browser-host.js'),
    ]);
    if (offscreen) {
      if (!options.host) throw new GlobeError('invalid-option', 'An OffscreenCanvas renderer needs a host');
      return withModels(
        await ThreeBackend.create({ kind: 'offscreen', canvas }, options.host, events, settings),
        options,
      );
    }
    const element = container as HTMLElement;
    const { createBrowserHost } = hostModule ?? (await import('./browser-host.js'));
    const backend = await ThreeBackend.create(
      { kind: 'element', container: element, canvas: canvas as HTMLCanvasElement | undefined },
      options.host ?? createBrowserHost(element),
      events,
      settings,
    );
    return withModels(backend, options);
  };
}

/** Gives a backend the application's glTF loader for models (F361), if any. */
function withModels<T extends { readonly models: { loaderFactory: GltfLoaderFactory | undefined } }>(
  backend: T,
  options: RendererOptions,
): T {
  backend.models.loaderFactory = options.gltf;
  return backend;
}

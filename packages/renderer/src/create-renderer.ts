import type { RendererFactory } from '@vibeglobe/core';
import type { BackendChoice } from './three-backend.js';

/** Options of {@link createRenderer}. */
export interface RendererOptions {
  /** 'auto' (default) uses WebGPU and falls back to WebGL2; 'webgpu' or 'webgl2' force a backend. */
  readonly backend?: BackendChoice;
  /** A canvas inside the container to draw into; by default the renderer creates one. */
  readonly canvas?: HTMLCanvasElement;
}

/**
 * Creates the renderer plug-in for `createGlobe` (ADR 0010): three.js WebGPURenderer with an automatic WebGL2 fallback.
 * three.js is loaded only when the globe starts (it writes to `window` when imported), so importing this package is
 * SSR-safe and costs no rendering code until a globe exists.
 */
export function createRenderer(options: RendererOptions = {}): RendererFactory {
  const choice = options.backend ?? 'auto';
  return async (container, events) => {
    const element = container as HTMLElement;
    const [{ ThreeBackend }, { createBrowserHost }] = await Promise.all([
      import('./three-backend.js'),
      import('./browser-host.js'),
    ]);
    return ThreeBackend.create(element, createBrowserHost(element), choice, events, options.canvas);
  };
}

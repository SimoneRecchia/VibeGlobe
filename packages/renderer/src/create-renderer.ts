import type { RendererFactory } from '@vibeglobe/core';
import { createBrowserHost } from './browser-host.js';
import { ThreeBackend, type BackendChoice } from './three-backend.js';

/** Options of {@link createRenderer}. */
export interface RendererOptions {
  /** 'auto' (default) uses WebGPU and falls back to WebGL2; 'webgpu' or 'webgl2' force a backend. */
  readonly backend?: BackendChoice;
  /** A canvas inside the container to draw into; by default the renderer creates one. */
  readonly canvas?: HTMLCanvasElement;
}

/**
 * Creates the renderer plug-in for `createGlobe` (ADR 0010): three.js WebGPURenderer with an automatic WebGL2 fallback.
 * Nothing touches the DOM or the GPU until the globe calls the returned factory, so importing is SSR-safe.
 */
export function createRenderer(options: RendererOptions = {}): RendererFactory {
  const choice = options.backend ?? 'auto';
  return (container, events) => {
    const element = container as HTMLElement;
    return ThreeBackend.create(element, createBrowserHost(element), choice, events, options.canvas);
  };
}

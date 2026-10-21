/**
 * @packageDocumentation
 * Renderer backend: WebGPU with automatic WebGL2 fallback, shaders, GPU resource management.
 * @module @vibeglobe/renderer
 */
export { createRenderer } from './create-renderer.js';
export type { RendererOptions } from './create-renderer.js';
export type { BackendChoice, DepthChoice } from './three-backend.js';
export { runGpuProbes } from './run-gpu-probes.js';
export type { GpuProbeOptions, GpuProbeResult } from './gpu-probes.js';

// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * @packageDocumentation
 * Renderer backend: WebGPU with automatic WebGL2 fallback, shaders, GPU resource management.
 * @module @vibeglobe/renderer
 */
export { createRenderer } from './create-renderer.js';
export type { RendererOptions } from './create-renderer.js';
export type { BackendChoice, DepthChoice } from './three-backend.js';
export type { ThreeExtensionContext } from './extensions.js';
export { runGpuProbes } from './run-gpu-probes.js';
export { gpuLoad } from './gpu-load.js';
export type { GpuProbeOptions, GpuProbeResult } from './gpu-probes.js';

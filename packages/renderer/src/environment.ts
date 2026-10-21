// Probes of what the browser offers, and image decoding with and without a DOM.
import { GlobeError } from '@vibeglobe/core';
import type { BackendChoice, DrawingSurface } from './three-backend.js';

/** True when the browser offers a WebGPU adapter. */
async function webgpuUsable(scope: typeof globalThis): Promise<boolean> {
  const gpu = (scope.navigator as Navigator | undefined)?.gpu;
  if (!gpu) return false;
  try {
    return (await gpu.requestAdapter()) !== null;
  } catch {
    return false;
  }
}

/** True when a WebGL2 context can be created. */
function webgl2Usable(surface: DrawingSurface): boolean {
  const probe =
    surface.kind === 'element' ? surface.container.ownerDocument.createElement('canvas') : new OffscreenCanvas(1, 1);
  const context = probe.getContext('webgl2') as WebGL2RenderingContext | null;
  context?.getExtension('WEBGL_lose_context')?.loseContext();
  return context !== null;
}

/**
 * Fetches and decodes an image, top row first. `createImageBitmap` decodes on a background thread; an image element
 * would be decoded on the main thread when uploaded, a single long task for a large base image (KB-066, F099).
 */
export async function decodeBitmap(url: string): Promise<ImageBitmap> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return createImageBitmap(await response.blob(), { imageOrientation: 'from-image' });
}

/**
 * Whether to start WebGPU for a backend choice: 'auto' takes it when an adapter exists. Throws `unsupported-device` when
 * the choice cannot be met; a forced backend never falls back (ADR 0010 §2).
 */
export async function chooseWebGPU(
  scope: typeof globalThis,
  surface: DrawingSurface,
  choice: BackendChoice,
): Promise<boolean> {
  const webgpu = choice !== 'webgl2' && (await webgpuUsable(scope));
  if (choice === 'webgpu' && !webgpu) {
    throw new GlobeError('unsupported-device', 'WebGPU was requested, but this browser offers no WebGPU adapter.');
  }
  if (!webgpu && !webgl2Usable(surface)) {
    throw new GlobeError(
      'unsupported-device',
      'This device supports neither WebGPU nor WebGL2, so the globe cannot render.',
    );
  }
  return webgpu;
}

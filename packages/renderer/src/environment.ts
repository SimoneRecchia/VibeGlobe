// Probes of what the browser offers, and image decoding with and without a DOM.
import type { DrawingSurface } from './three-backend.js';

/** True when the browser offers a WebGPU adapter. */
export async function webgpuUsable(scope: typeof globalThis): Promise<boolean> {
  const gpu = (scope.navigator as Navigator | undefined)?.gpu;
  if (!gpu) return false;
  try {
    return (await gpu.requestAdapter()) !== null;
  } catch {
    return false;
  }
}

/** True when a WebGL2 context can be created. */
export function webgl2Usable(surface: DrawingSurface): boolean {
  const probe =
    surface.kind === 'element' ? surface.container.ownerDocument.createElement('canvas') : new OffscreenCanvas(1, 1);
  const context = probe.getContext('webgl2') as WebGL2RenderingContext | null;
  context?.getExtension('WEBGL_lose_context')?.loseContext();
  return context !== null;
}

/** Decodes an image in the page. */
export async function decodeImage(url: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.crossOrigin = 'anonymous';
  image.src = url;
  await image.decode();
  return image;
}

/** Fetches and decodes an image where there is no DOM (ADR 0011), flipped at decode time like the page's images. */
export async function decodeBitmap(url: string): Promise<ImageBitmap> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return createImageBitmap(await response.blob(), { imageOrientation: 'flipY' });
}

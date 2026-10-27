// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { RendererCapabilities } from '@vibeglobe/core';
import type { WebGPURenderer } from 'three/webgpu';
import { depthFormatOf, depthPathOf, type SceneDepth } from './depth.js';

const COMPRESSED_FEATURES: readonly [string, string][] = [
  ['texture-compression-bc', 'bc'],
  ['texture-compression-etc2', 'etc2'],
  ['texture-compression-astc', 'astc'],
];

const COMPRESSED_EXTENSIONS: readonly [string, string][] = [
  ['WEBGL_compressed_texture_s3tc', 'bc'],
  ['EXT_texture_compression_bptc', 'bc'],
  ['WEBGL_compressed_texture_etc', 'etc2'],
  ['WEBGL_compressed_texture_astc', 'astc'],
];

/**
 * Reads the active backend, GPU limits and memory hints from an initialized renderer (F056). `allowedCompressed`
 * limits the compressed families reported to those listed (`RendererOptions.compressedTextures`).
 */
export function readCapabilities(
  renderer: WebGPURenderer,
  sceneDepth: SceneDepth,
  allowedCompressed?: readonly string[],
): RendererCapabilities {
  const capabilities = readDeviceCapabilities(renderer, sceneDepth);
  if (!allowedCompressed) return capabilities;
  const compressedTextureFormats = capabilities.compressedTextureFormats.filter((family) =>
    allowedCompressed.includes(family),
  );
  return { ...capabilities, compressedTextureFormats };
}

function readDeviceCapabilities(renderer: WebGPURenderer, sceneDepth: SceneDepth): RendererCapabilities {
  const backend = renderer.backend as {
    device?: GPUDevice;
    gl?: WebGL2RenderingContext;
    adapterInfo?: GPUAdapterInfo;
  };
  // An OffscreenCanvas has no document: its global scope (a worker's) has the navigator.
  const navigator = ((renderer.domElement as HTMLCanvasElement).ownerDocument?.defaultView?.navigator ??
    globalThis.navigator) as (Navigator & { deviceMemory?: number }) | undefined;
  const deviceMemoryGiB = navigator?.deviceMemory;
  const maxAnisotropy = renderer.getMaxAnisotropy();
  const depth = { depthPath: depthPathOf(renderer), depthFormat: depthFormatOf(renderer, sceneDepth) };
  if (backend.device) {
    const formats = new Set<string>();
    for (const [feature, family] of COMPRESSED_FEATURES) {
      if (backend.device.features.has(feature)) formats.add(family);
    }
    const info = backend.device.adapterInfo as GPUAdapterInfo | undefined;
    return {
      backend: 'webgpu',
      maxTextureSize: backend.device.limits.maxTextureDimension2D,
      maxAnisotropy,
      compressedTextureFormats: [...formats],
      deviceMemoryGiB,
      adapter: info ? [info.vendor, info.architecture, info.description].filter(Boolean).join(' ') : 'unknown',
      ...depth,
    };
  }
  const gl = backend.gl;
  const formats = new Set<string>();
  if (gl) for (const [extension, family] of COMPRESSED_EXTENSIONS) if (gl.getExtension(extension)) formats.add(family);
  const debugInfo = gl?.getExtension('WEBGL_debug_renderer_info');
  return {
    backend: 'webgl2',
    maxTextureSize: gl ? (gl.getParameter(gl.MAX_TEXTURE_SIZE) as number) : 0,
    maxAnisotropy,
    compressedTextureFormats: [...formats],
    deviceMemoryGiB,
    adapter: gl && debugInfo ? String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)) : 'unknown',
    ...depth,
  };
}

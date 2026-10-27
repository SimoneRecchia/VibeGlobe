// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { DepthPath } from '@vibeglobe/core';
import { DepthTexture, FloatType, type RenderTarget, type WebGPURenderer } from 'three/webgpu';
import { webglDepthFormat } from './webgl-compat.js';

/** The private members of three.js 0.186 used here (ADR 0010: pinned internals, where needed). */
interface RendererInternals {
  _getFrameBufferTarget(): RenderTarget | null;
}

interface BackendInternals {
  get(object: object): { texture?: GPUTexture };
}

/** The scene's depth: the framebuffer target it is drawn into and that target's depth texture. */
export interface SceneDepth {
  readonly target: RenderTarget;
  readonly texture: DepthTexture;
}

/** WebGL2 depth formats by internal format, named as in WebGPU. */
const GL_DEPTH_FORMATS: Readonly<Record<number, string>> = {
  0x8cac: 'depth32float', // DEPTH_COMPONENT32F
  0x8cad: 'depth32float-stencil8', // DEPTH32F_STENCIL8
  0x81a6: 'depth24plus', // DEPTH_COMPONENT24
  0x88f0: 'depth24plus-stencil8', // DEPTH24_STENCIL8
  0x81a5: 'depth16unorm', // DEPTH_COMPONENT16
};

/**
 * Gives the scene a 32-bit float depth attachment on every path (ADR 0005 §3) and returns it. three.js 0.186 draws the
 * scene into its own framebuffer target (the output color space differs from the working one), whose depth defaults to
 * 24-bit; a depth texture of FloatType makes it depth32float on WebGPU and DEPTH_COMPONENT32F on WebGL2, for the
 * multisampled renderbuffer too (with `useFloatMultisampledDepth` on WebGL2). Throws when the renderer draws straight
 * to the canvas, whose depth cannot be float.
 */
export function useFloatSceneDepth(renderer: WebGPURenderer): SceneDepth {
  const target = (renderer as unknown as RendererInternals)._getFrameBufferTarget();
  if (!target) throw new Error('The renderer draws to the canvas directly, so its scene depth cannot be float');
  const texture = new DepthTexture(1, 1, FloatType);
  target.depthTexture = texture;
  renderer.initRenderTarget(target);
  return { target, texture };
}

/** The format the GPU actually allocated for the scene depth, named as in WebGPU. */
export function depthFormatOf(renderer: WebGPURenderer, depth: SceneDepth): string {
  const glFormat = webglDepthFormat(renderer.backend, depth.target, depth.texture);
  if (glFormat !== undefined) return GL_DEPTH_FORMATS[glFormat] ?? 'unknown';
  return (renderer.backend as unknown as BackendInternals).get(depth.texture).texture?.format ?? 'unknown';
}

/** The active depth path: three.js keeps reversed depth unless WebGL2 lacks `EXT_clip_control` or it was not asked. */
export function depthPathOf(renderer: WebGPURenderer): DepthPath {
  return renderer.reversedDepthBuffer ? 'reversed-z' : 'fragment';
}

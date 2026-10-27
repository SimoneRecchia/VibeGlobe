// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { FloatType } from 'three/webgpu';

/** What three.js 0.186 passes to its renderbuffer setup: the render context, with its render target. */
interface RenderContextInternals {
  renderTarget: {
    depthBuffer: boolean;
    stencilBuffer: boolean;
    width: number;
    height: number;
    depthTexture: { type: number } | null;
  };
}

/** The private members of three.js 0.186's WebGL2 backend used here (ADR 0010: pinned internals, where needed). */
interface WebGLBackendInternals {
  isWebGLBackend?: boolean;
  gl: WebGL2RenderingContext;
  vaoCache: Record<string, WebGLVertexArrayObject>;
  get(object: object): { id?: number; depthRenderbuffer?: WebGLRenderbuffer; glInternalFormat?: number };
  destroyAttribute(attribute: object): void;
  textureUtils: {
    setupRenderBufferStorage(
      renderbuffer: WebGLRenderbuffer,
      renderContext: RenderContextInternals,
      samples: number,
      useMultisampledRTT?: boolean,
    ): void;
  };
}

function webglBackend(backend: unknown): WebGLBackendInternals | undefined {
  const candidate = backend as Partial<WebGLBackendInternals>;
  return candidate.isWebGLBackend === true && candidate.vaoCache ? (candidate as WebGLBackendInternals) : undefined;
}

/**
 * three.js 0.186 caches one WebGL2 vertex array object per set of attribute buffers and never deletes it, so every
 * geometry ever drawn leaks one (three.js #34597, fixed after 0.186). This deletes the cached vertex arrays that use a
 * buffer when the buffer is destroyed (KB-021). The cache keys list the buffer ids as ":id:id…".
 */
export function releaseVertexArraysWithBuffers(backend: unknown): void {
  const internals = webglBackend(backend);
  if (!internals) return;
  const destroyAttribute = internals.destroyAttribute.bind(internals);
  internals.destroyAttribute = (attribute: object) => {
    const id = internals.get(attribute).id;
    if (id !== undefined) {
      const segment = String(id);
      for (const key of Object.keys(internals.vaoCache)) {
        if (!key.split(':').includes(segment)) continue;
        const vertexArray = internals.vaoCache[key];
        if (vertexArray) internals.gl.deleteVertexArray(vertexArray);
        Reflect.deleteProperty(internals.vaoCache, key);
      }
    }
    destroyAttribute(attribute);
  };
}

/**
 * Deletes every vertex array object the WebGL2 backend still caches, before its context is released: three.js's own
 * output-pass quad keeps one that no geometry disposal removes (KB-030).
 */
export function releaseAllVertexArrays(backend: unknown): void {
  const internals = webglBackend(backend);
  if (!internals) return;
  for (const key of Object.keys(internals.vaoCache)) {
    const vertexArray = internals.vaoCache[key];
    if (vertexArray) internals.gl.deleteVertexArray(vertexArray);
    Reflect.deleteProperty(internals.vaoCache, key);
  }
}

/** The vertex array objects the WebGL2 backend holds; 0 on WebGPU. */
export function countVertexArrays(backend: unknown): number {
  const internals = webglBackend(backend);
  return internals ? Object.keys(internals.vaoCache).length : 0;
}

/**
 * three.js 0.186 gives a multisampled render target a 24-bit depth renderbuffer even when its depth texture is float:
 * it compares the texture type (FloatType) with `gl.FLOAT`, which never match. The scene is then depth-tested in 24
 * bits, and resolving into the float depth texture fails ("format combination not allowed for blit"). This allocates
 * DEPTH_COMPONENT32F for float depth textures instead (ADR 0005 §3, KB-024).
 */
export function useFloatMultisampledDepth(backend: unknown): void {
  const internals = webglBackend(backend);
  if (!internals) return;
  const utils = internals.textureUtils;
  const setup = utils.setupRenderBufferStorage.bind(utils);
  utils.setupRenderBufferStorage = (renderbuffer, renderContext, samples, useMultisampledRTT = false) => {
    const target = renderContext.renderTarget;
    const floatDepth = target.depthBuffer && !target.stencilBuffer && target.depthTexture?.type === FloatType;
    if (!floatDepth || samples <= 0 || useMultisampledRTT) {
      setup(renderbuffer, renderContext, samples, useMultisampledRTT);
      return;
    }
    const gl = internals.gl;
    gl.bindRenderbuffer(gl.RENDERBUFFER, renderbuffer);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.DEPTH_COMPONENT32F, target.width, target.height);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, renderbuffer);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
  };
}

/**
 * The internal format of the depth the scene is drawn into on WebGL2: the multisampled renderbuffer when there is one,
 * else the depth texture; undefined on WebGPU.
 */
export function webglDepthFormat(backend: unknown, target: object, depthTexture: object): number | undefined {
  const internals = webglBackend(backend);
  if (!internals) return undefined;
  const renderbuffer = internals.get(target).depthRenderbuffer;
  if (!renderbuffer) return internals.get(depthTexture).glInternalFormat;
  const gl = internals.gl;
  gl.bindRenderbuffer(gl.RENDERBUFFER, renderbuffer);
  const format = gl.getRenderbufferParameter(gl.RENDERBUFFER, gl.RENDERBUFFER_INTERNAL_FORMAT) as number;
  gl.bindRenderbuffer(gl.RENDERBUFFER, null);
  return format;
}

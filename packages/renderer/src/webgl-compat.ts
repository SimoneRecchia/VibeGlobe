/** The private members of three.js 0.186's WebGL2 backend used here (ADR 0010: pinned internals, where needed). */
interface WebGLBackendInternals {
  isWebGLBackend?: boolean;
  gl: WebGL2RenderingContext;
  vaoCache: Record<string, WebGLVertexArrayObject>;
  get(object: object): { id?: number };
  destroyAttribute(attribute: object): void;
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

/** The vertex array objects the WebGL2 backend holds; 0 on WebGPU. */
export function countVertexArrays(backend: unknown): number {
  const internals = webglBackend(backend);
  return internals ? Object.keys(internals.vaoCache).length : 0;
}

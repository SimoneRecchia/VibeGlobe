import { describe, expect, it } from 'vitest';
import { releaseVertexArraysWithBuffers } from './webgl-compat.js';

describe('releaseVertexArraysWithBuffers (KB-021)', () => {
  it('deletes the cached vertex arrays that use a destroyed buffer, and only those', () => {
    const deleted: string[] = [];
    const ids = new Map<object, number>();
    const backend = {
      isWebGLBackend: true,
      gl: { deleteVertexArray: (array: string) => deleted.push(array) },
      vaoCache: { ':1:2': 'a', ':12:3': 'b', ':3:1': 'c', ':21': 'd', ':4:1:5': 'e' } as Record<string, string>,
      get: (object: object) => ({ id: ids.get(object) }),
      destroyAttribute: (attribute: object): void => void ids.get(attribute),
    };
    releaseVertexArraysWithBuffers(backend);
    const buffer = {};
    ids.set(buffer, 1);
    backend.destroyAttribute(buffer);
    expect(deleted.sort()).toEqual(['a', 'c', 'e']);
    expect(Object.keys(backend.vaoCache).sort()).toEqual([':12:3', ':21']);
  });
});

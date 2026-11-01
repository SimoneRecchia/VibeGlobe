import { describe, expect, it } from 'vitest';
import { quantizedMeshTerrain } from './quantized-mesh-terrain.js';

const url = 'https://dem.test/mesh/layer.json';
const answering =
  (respond: () => Response | Promise<Response>): typeof fetch =>
  async () =>
    respond();

describe('quantizedMeshTerrain', () => {
  it('rejects with a SourceConfigError when layer.json cannot be loaded or read (KB-327)', async () => {
    const cases: [typeof fetch, string][] = [
      [answering(() => new Response('', { status: 404 })), 'unreachable-layer'],
      [answering(() => Promise.reject(new TypeError('Failed to fetch'))), 'unreachable-layer'],
      [answering(() => new Response('not json')), 'invalid-layer'],
      [answering(() => Response.json({ format: 'quantized-mesh-1.0' })), 'invalid-layer'],
    ];
    for (const [fetchImpl, code] of cases) {
      const error = await quantizedMeshTerrain({ id: 'dem', url, fetchImpl }).catch((e: unknown) => e);
      expect(error, code).toMatchObject({ name: 'SourceConfigError', code });
    }
  });
});

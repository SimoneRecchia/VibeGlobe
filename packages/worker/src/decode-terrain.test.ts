import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { decodeTerrain } from './decode-terrain.js';
import { gunzip } from './mesh-terrain.js';
import { TaskError, type TaskContext } from './protocol.js';

describe('gunzip', () => {
  it('inflates gzip-compressed bytes (F127)', async () => {
    const bytes = Uint8Array.from({ length: 100_000 }, (_, i) => i % 251);
    const inflated = await gunzip(new Uint8Array(gzipSync(bytes)));
    expect(inflated).toEqual(bytes);
  });

  it('fails with undecodable once the output passes the limit, without inflating the rest (F131)', async () => {
    // 64 MB of zeros compress to about 64 KB: a gzip bomb against a 1 MB limit.
    const bomb = new Uint8Array(gzipSync(new Uint8Array(64 * 1024 * 1024)));
    const failure = gunzip(bomb, 1024 * 1024);
    await expect(failure).rejects.toBeInstanceOf(TaskError);
    await expect(failure).rejects.toMatchObject({ code: 'undecodable' });
  });
});

describe('decodeTerrain', () => {
  const fixture = (suffix: string): ArrayBuffer => {
    const bytes = readFileSync(
      new URL(`../../core/src/terrain/fixtures/geographic-8-266-62.${suffix}`, import.meta.url),
    );
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  };
  const context = { isCancelled: () => false } as TaskContext;

  it('decodes a gzip-compressed quantized-mesh tile like the plain one, within its error bound (F127, F134)', async () => {
    const input = (bytes: ArrayBuffer) => ({ bytes, encoding: 'quantized-mesh', maxErrorMeters: 5, meshCells: 8 });
    const plain = (await decodeTerrain(input(fixture('terrain')), context)).output as {
      image: { cells: number; heightsMeters: Float32Array; errorMeters: number };
    };
    const gzipped = (await decodeTerrain(input(fixture('terrain.gz')), context)).output as typeof plain;
    expect(gzipped.image.cells).toBe(plain.image.cells);
    expect([...gzipped.image.heightsMeters]).toEqual([...plain.image.heightsMeters]);
    // The 16-cell fixture mesh needs more than 8 cells to stay within 5 m of its vertices: the grid was refined.
    expect(plain.image.cells).toBeGreaterThan(8);
    expect(plain.image.errorMeters).toBeLessThanOrEqual(5);
  });

  it('closes the bitmap of a heightmap it refuses (not square)', async () => {
    const close = vi.fn();
    vi.stubGlobal('createImageBitmap', () => Promise.resolve({ width: 4, height: 2, close }));
    vi.stubGlobal('OffscreenCanvas', function OffscreenCanvas() {});
    try {
      const input = { bytes: new ArrayBuffer(8), encoding: 'terrarium', maxErrorMeters: 5, meshCells: 8 };
      await expect(decodeTerrain(input, context)).rejects.toMatchObject({ code: 'undecodable' });
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

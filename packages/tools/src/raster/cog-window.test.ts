import { describe, expect, it } from 'vitest';
import { readCogWindow, writeTiledTiff } from './cog-window.js';
import { readGeoTiff } from './tiff.js';

const TILE = 16;
const ACROSS = 4;
const DOWN = 3;
/** Sample value of band `b` at pixel (x, y) of the synthetic image. */
const sample = (x: number, y: number, b: number): number => 1 + x + 100 * y + 10_000 * b;

/** A 64 × 48 four-band uint16 COG at 1°/16 per pixel, north-west corner at 6°E 46°N, uncompressed 16-pixel tiles. */
function syntheticCog(): Uint8Array {
  const tiles: Uint8Array[] = [];
  for (let t = 0; t < ACROSS * DOWN; t++) {
    const samples = new Uint16Array(TILE * TILE * 4);
    for (let y = 0; y < TILE; y++)
      for (let x = 0; x < TILE; x++)
        for (let b = 0; b < 4; b++)
          samples[(y * TILE + x) * 4 + b] = sample((t % ACROSS) * TILE + x, Math.floor(t / ACROSS) * TILE + y, b);
    tiles.push(new Uint8Array(samples.buffer));
  }
  return writeTiledTiff(
    [
      [256, 3, [ACROSS * TILE]],
      [257, 3, [DOWN * TILE]],
      [258, 3, [16, 16, 16, 16]],
      [259, 3, [1]],
      [262, 3, [2]],
      [277, 3, [4]],
      [284, 3, [1]],
      [322, 3, [TILE]],
      [323, 3, [TILE]],
      [338, 3, [0, 0]],
      [339, 3, [1, 1, 1, 1]],
      [33550, 12, [1 / 16, 1 / 16, 0]],
      [33922, 12, [0, 0, 0, 6, 46, 0]],
      [34735, 3, [1, 1, 0, 1, 1024, 0, 1, 2]],
    ],
    tiles,
  );
}

/** Serves `file` with range requests; records each requested range. */
function rangeServer(file: Uint8Array | undefined, ranges: string[]): typeof fetch {
  return (async (_url: string, init?: RequestInit) => {
    if (!file) return new Response('', { status: 404 });
    const range = (init?.headers as Record<string, string>)['range'] ?? '';
    ranges.push(range);
    const [start = 0, end = 0] = (/bytes=(\d+)-(\d+)/.exec(range) ?? []).slice(1).map(Number);
    return new Response(file.slice(start, end + 1), { status: 206 });
  }) as typeof fetch;
}

describe('readCogWindow', () => {
  it('fetches only the internal tiles that intersect the window and keeps their pixels in place', async () => {
    const ranges: string[] = [];
    // Pixels 4.8–17.6 across and 6.4–11.2 down: tile columns 0 and 1 of tile row 0.
    const bbox = { west: 6.3, south: 45.3, east: 7.1, north: 45.6 };
    const window = await readCogWindow(rangeServer(syntheticCog(), ranges), 'https://cog.test/a.tif', bbox, 0);
    expect(window.tiles).toBe(2);
    expect(ranges).toHaveLength(3);
    const raster = readGeoTiff(window.file);
    expect([raster.width, raster.height, raster.westDeg, raster.northDeg]).toEqual([64, 48, 6, 46]);
    const at = (x: number, y: number): number[] => [...raster.data.subarray((y * 64 + x) * 4, (y * 64 + x) * 4 + 4)];
    expect(at(5, 7)).toEqual([0, 1, 2, 3].map((b) => sample(5, 7, b)));
    expect(at(20, 10)).toEqual([0, 1, 2, 3].map((b) => sample(20, 10, b)));
    // Tile column 2 and tile row 1 were not read: no data.
    expect(at(40, 10)).toEqual([0, 0, 0, 0]);
    expect(at(5, 20)).toEqual([0, 0, 0, 0]);
  });

  it('rejects a missing file with status 404', async () => {
    const read = readCogWindow(
      rangeServer(undefined, []),
      'https://cog.test/none.tif',
      { west: 6, south: 45, east: 7, north: 46 },
      0,
    );
    await expect(read).rejects.toMatchObject({ status: 404 });
  });
});

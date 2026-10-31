// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { describe, expect, it, vi } from 'vitest';
import { RasterLayers, type RasterLayerContext } from './raster-layers.js';
import { StyleLayer } from './style-layer.js';

const SIZE = 4;

describe('raster layers over changing terrain (KB-242)', () => {
  it('keep a hillshade tile mesh and its image as the terrain and the zoom change, refreshing only its ground', async () => {
    const createMesh = vi.fn(() => ({ update: vi.fn(), dispose: vi.fn() }));
    const grounds = {
      version: 0,
      active: true,
      canDrape: true,
      heights: (_t: unknown, _xy: unknown, out: unknown) => out,
    };
    const context = {
      target: { createMesh },
      transport: {
        start: (_r: unknown, _t: unknown, done: (result: unknown) => void) => {
          done({ kind: 'ok', bytes: new ArrayBuffer(0), contentType: 'image/webp' });
          return () => undefined;
        },
      },
      sources: new Map([
        [
          'dem',
          {
            templates: ['d/{z}/{x}/{y}'],
            scheme: 'xyz',
            coverage: { minzoom: 0, maxzoom: 12 },
            raster: { tileSize: SIZE, encoding: 'terrarium' },
          },
        ],
      ]),
      grounds,
      onReady: () => undefined,
      buckets: () => undefined,
      decode: () =>
        Promise.resolve({ width: SIZE, height: SIZE, data: new Uint8ClampedArray(SIZE * SIZE * 4).fill(128) }),
    } as unknown as RasterLayerContext;
    const rasters = new RasterLayers(context);
    const layer = new StyleLayer({ id: 'shade', type: 'hillshade', source: 'dem' } as never);
    const tile = { z: 10, x: 545, y: 380 };
    const draw = (zoom: number) => {
      rasters.beginFrame();
      return rasters.draws(layer, 1, zoom, 0, [tile], []);
    };
    draw(10.2);
    await Promise.resolve();
    await Promise.resolve();
    const first = draw(10.2)?.draws[0]?.mesh;
    expect(createMesh).toHaveBeenCalledTimes(1);
    for (let version = 1; version <= 5; version++) {
      grounds.version = version;
      expect(draw(10.2 + version * 0.3)?.draws[0]?.mesh).toBe(first);
    }
    expect(createMesh).toHaveBeenCalledTimes(1);
    expect(vi.mocked(first?.update)).toHaveBeenCalledWith({ ground: expect.any(Float32Array) });
  });
});

describe('raster tiles that fail on the way', () => {
  it('requests a tile that failed with a 503 again later, and one answered 404 never', async () => {
    vi.useFakeTimers();
    try {
      const asked: string[] = [];
      const answers = new Map([
        ['r/10/545/380', [503, 200]],
        ['r/10/546/380', [404, 200]],
      ]);
      const context = {
        target: { createMesh: vi.fn(() => ({ update: vi.fn(), dispose: vi.fn() })) },
        transport: {
          start: (request: { url: string }, _t: unknown, done: (result: unknown) => void) => {
            asked.push(request.url);
            const status = answers.get(request.url)?.shift() ?? 200;
            done(
              status === 200
                ? { kind: 'ok', bytes: new ArrayBuffer(0), contentType: 'image/png' }
                : { kind: 'status', status, retryAfterMs: undefined },
            );
            return () => undefined;
          },
        },
        sources: new Map([
          [
            'sat',
            {
              templates: ['r/{z}/{x}/{y}'],
              scheme: 'xyz',
              coverage: { minzoom: 0, maxzoom: 12 },
              raster: { tileSize: SIZE },
            },
          ],
        ]),
        grounds: { version: 0, active: false, canDrape: false, heights: () => undefined },
        onReady: () => undefined,
        buckets: () => undefined,
        decode: () => Promise.resolve({ width: SIZE, height: SIZE, data: new Uint8ClampedArray(SIZE * SIZE * 4) }),
      } as unknown as RasterLayerContext;
      const rasters = new RasterLayers(context);
      const layer = new StyleLayer({ id: 'sat', type: 'raster', source: 'sat' } as never);
      const tiles = [
        { z: 10, x: 545, y: 380 },
        { z: 10, x: 546, y: 380 },
      ];
      const draw = (): void => {
        rasters.beginFrame();
        rasters.draws(layer, 1, 10, 0, tiles, []);
      };
      draw();
      draw();
      expect(asked).toEqual(['r/10/545/380', 'r/10/546/380']);
      await vi.advanceTimersByTimeAsync(10_000);
      draw();
      expect(asked).toEqual(['r/10/545/380', 'r/10/546/380', 'r/10/545/380']);
    } finally {
      vi.useRealTimers();
    }
  });
});

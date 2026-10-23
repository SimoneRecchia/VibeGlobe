import { describe, expect, it } from 'vitest';
import type { TileCoord } from '@vibeglobe/core';
import { transformCoordinates } from '@vibeglobe/gis';
import { geoImagePng, geoImageTiff, worldFileOf, type GeoImageSpec } from './__fixtures__/georeferenced.js';
import { failures, mutate, runTiledConformance } from './conformance/index.js';
import { geotiffImage, readGeotiff } from './geotiff.js';
import { SourceConfigError } from './metadata.js';
import { imageSizeOf, parseWorldFile, singleImage } from './single-image.js';

const coord = (level: number, x: number, y: number): TileCoord => ({ root: 0, level, x, y });
const transforms = (crs: string) =>
  crs === 'EPSG:32632'
    ? {
        toSource: (lon: number, lat: number): [number, number] => {
          const p = transformCoordinates({ x: lon, y: lat }, 'EPSG:4326', crs);
          return [p.x, p.y];
        },
        fromSource: (x: number, y: number): [number, number] => {
          const p = transformCoordinates({ x, y }, crs, 'EPSG:4326');
          return [p.x, p.y];
        },
      }
    : undefined;
const mercator = (lon: number, lat: number) => transformCoordinates({ x: lon, y: lat }, 'EPSG:4326', 'EPSG:3857');
const SW = mercator(6, 42);
const NE = mercator(12, 48);
const SPECS: readonly GeoImageSpec[] = [
  { crs: 'EPSG:4326', box: [6, 42, 12, 48], widthPx: 256, heightPx: 256 },
  { crs: 'EPSG:3857', box: [SW.x, SW.y, NE.x, NE.y], widthPx: 256, heightPx: 256 },
  { crs: 'EPSG:32632', box: [300_000, 4_650_000, 800_000, 5_300_000], widthPx: 256, heightPx: 256 },
];
// Node has no OffscreenCanvas: the composition and the warp are replaced by stand-ins that keep the bytes flowing.
const stand = {
  composeImage: () => Promise.resolve(new Uint8Array([1]).buffer),
  warpImage: () => Promise.resolve(new Uint8Array([2]).buffer),
};
/** Inside every fixture image (9° E, 45° N) and outside all of them. */
const INSIDE = coord(5, 16, 11);
const OUTSIDE = coord(5, 0, 11);

function served(url: string, body: Uint8Array | ArrayBuffer): typeof fetch {
  return (input) =>
    Promise.resolve(String(input) === url ? new Response(body.slice(0)) : new Response(null, { status: 404 }));
}

describe('single georeferenced images (F234)', () => {
  for (const spec of SPECS)
    for (const by of ['bounds', 'world file', 'GeoTIFF'] as const)
      it(`pass the conformance suite, georeferenced by ${by} in ${spec.crs}`, async () => {
        const url = `https://images.test/${spec.crs}.${by === 'GeoTIFF' ? 'tif' : 'png'}`;
        const body = by === 'GeoTIFF' ? geoImageTiff(spec) : geoImagePng(spec);
        const results = await runTiledConformance({
          name: `${by} ${spec.crs}`,
          create: (fetchImpl) =>
            by === 'GeoTIFF'
              ? geotiffImage({
                  id: 'image',
                  image: url,
                  fetch: fetchImpl,
                  downloadTimeoutMs: 300,
                  transforms,
                  ...stand,
                })
              : singleImage({
                  id: 'image',
                  image: url,
                  fetch: fetchImpl,
                  downloadTimeoutMs: 300,
                  crs: spec.crs,
                  ...(by === 'bounds' ? { bounds: spec.box } : { worldFile: worldFileOf(spec) }),
                  transforms,
                  attribution: [{ text: '© Image provider' }],
                  ...stand,
                }),
          fixture: served(url, body),
          network: 'on-open',
          tiles: [{ coord: INSIDE }],
          outside: [OUTSIDE],
        });
        expect(failures(results)).toEqual([]);
      });

  it('places the image where its georeference says, whichever way it is given', async () => {
    const spec = SPECS[2] as GeoImageSpec;
    const png = geoImagePng(spec);
    const byBounds = await singleImage({
      id: 'a',
      image: new Blob([png]),
      crs: spec.crs,
      bounds: spec.box,
      transforms,
      ...stand,
    });
    const byWorld = await singleImage({
      id: 'b',
      image: new Blob([png]),
      crs: spec.crs,
      worldFile: worldFileOf(spec),
      transforms,
      ...stand,
    });
    const byTiff = await geotiffImage({ id: 'c', image: new Blob([geoImageTiff(spec)]), transforms, ...stand });
    for (const source of [byWorld, byTiff]) {
      expect(source.coverage?.[0]?.westRad).toBeCloseTo(byBounds.coverage?.[0]?.westRad ?? NaN, 9);
      expect(source.coverage?.[0]?.northRad).toBeCloseTo(byBounds.coverage?.[0]?.northRad ?? NaN, 9);
      expect(source.maxLevel).toBe(byBounds.maxLevel);
    }
    const tiff = await readGeotiff(geoImageTiff(spec));
    expect(tiff.crs).toBe('EPSG:32632');
    expect(tiff.bounds.map((v) => Math.round(v))).toEqual([...spec.box]);
  });

  it('refuses images it cannot place, with a descriptive error', async () => {
    const png = geoImagePng(SPECS[0] as GeoImageSpec);
    const attempts = [
      singleImage({ id: 'x', image: new Blob([png]) }),
      singleImage({ id: 'x', image: new Blob([png]), bounds: [10, 40, 5, 45] }),
      singleImage({ id: 'x', image: new Blob([png]), worldFile: '1\n0.5\n0\n-1\n0\n0' }),
      singleImage({ id: 'x', image: new Blob([png]), crs: 'EPSG:2056', bounds: [0, 0, 1, 1] }),
      singleImage({
        id: 'x',
        image: new Blob([new Uint8Array([1, 2, 3]) as Uint8Array<ArrayBuffer>]),
        bounds: [0, 0, 1, 1],
      }),
      geotiffImage({ id: 'x', image: new Blob([png]) }),
    ];
    for (const attempt of attempts) await expect(attempt).rejects.toBeInstanceOf(SourceConfigError);
  });

  it('never throws on malformed world files, image headers or GeoTIFFs (fuzz)', { timeout: 60_000 }, async () => {
    let seed = 42;
    const random = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const world = worldFileOf(SPECS[0] as GeoImageSpec);
    const png = geoImagePng(SPECS[0] as GeoImageSpec);
    const tiff = new Uint8Array(geoImageTiff(SPECS[2] as GeoImageSpec));
    for (let run = 0; run < 300; run++) {
      const text = mutate(world, random);
      const parsed = parseWorldFile(text);
      if (parsed) expect(Object.values(parsed).every(Number.isFinite)).toBe(true);
      const size = imageSizeOf(mutate(png, random));
      if (size) expect(size.every((v) => Number.isInteger(v) && v > 0)).toBe(true);
    }
    for (let run = 0; run < 60; run++) {
      const bytes = mutate(tiff, random);
      await readGeotiff(bytes.slice().buffer).then(
        (read) => expect(read.sizePx.every((v) => v > 0)).toBe(true),
        (error: unknown) => expect(error).toBeInstanceOf(SourceConfigError),
      );
    }
  });
});

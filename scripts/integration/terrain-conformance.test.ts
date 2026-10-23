// F235: the terrain adapters (quantized-mesh, Terrarium, Terrain-RGB) pass the shared adapter conformance suite with
// the fixture tiles of scripts/fixtures/tiles/terrain.ts, and decode heights within their encoding's precision.
import type { TileCoord } from '@vibeglobe/core';
import { heightmapTerrain, quantizedMeshTerrain, fetchTransport, CUSTOM_PROFILE } from '@vibeglobe/sources';
import {
  failures,
  runTerrainConformance,
  type ReferenceHeight,
  type TerrainConformanceSubject,
} from '@vibeglobe/sources/conformance';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { fixturePosition, type FixtureTile } from '../fixtures/tiles/generate.ts';
import { fixtureHeightMeters, terrainTile, type TerrainEncoding } from '../fixtures/tiles/terrain.ts';

const DEG = Math.PI / 180;
const coord = (level: number, x: number, y: number): TileCoord => ({ root: 0, level, x, y });
const fixtureTile = (c: TileCoord): FixtureTile => ({
  pattern: 'terrain' as FixtureTile['pattern'],
  scheme: 'mercator',
  ...c,
});
/** Tiles over rolling hills (no peak, ridge or cone), so interpolation between samples stays far below a meter. */
const TILES = [coord(6, 40, 28), coord(5, 20, 14)];
/** A tile inside the levels and coverage that the fixture service answers with 404. */
const MISSING = coord(6, 41, 28);
const ATTRIBUTION = [{ text: '© Fixture terrain', url: 'https://example.test/terrain' }];

/** The fixture's height at a point of a tile. */
function reference(c: TileCoord, u: number, v: number, toleranceMeters: number): ReferenceHeight {
  const { lonRad, latRad } = fixturePosition(fixtureTile(c), u, v);
  return { coord: c, u, v, meters: fixtureHeightMeters(lonRad, latRad), toleranceMeters };
}

function references(toleranceMeters: number): ReferenceHeight[] {
  return TILES.flatMap((c) => [reference(c, 0.5, 0.5, toleranceMeters), reference(c, 0.125, 0.75, toleranceMeters)]);
}

/** A fixture service of one encoding at `{z}/{x}/{y}.{ext}` (XYZ rows; quantized-mesh rows from the south). */
function service(encoding: TerrainEncoding): typeof fetch {
  return (input) => {
    const url = String(input);
    if (url.endsWith('layer.json'))
      return Promise.resolve(
        Response.json({
          tilejson: '2.1.0',
          format: 'quantized-mesh-1.0',
          version: '1.0.0',
          scheme: 'tms',
          tiles: ['{z}/{x}/{y}.terrain'],
          projection: 'EPSG:3857',
          minzoom: 0,
          maxzoom: 8,
          // Levels 5–8 cover only the eastern hemisphere, where the test tiles lie: others are outside the coverage.
          available: Array.from({ length: 9 }, (_, z) =>
            z < 5
              ? [{ startX: 0, startY: 0, endX: 2 ** z - 1, endY: 2 ** z - 1 }]
              : [{ startX: 2 ** (z - 1), startY: 0, endX: 2 ** z - 1, endY: 2 ** z - 1 }],
          ),
          attribution: ATTRIBUTION[0]?.text,
        }),
      );
    const match = /\/(\d+)\/(\d+)\/(\d+)\.\w+$/.exec(url);
    if (!match) return Promise.resolve(new Response(null, { status: 404 }));
    const level = Number(match[1]);
    const x = Number(match[2]);
    const row = Number(match[3]);
    const y = encoding === 'quantized-mesh' ? 2 ** level - 1 - row : row;
    if (level === MISSING.level && x === MISSING.x && y === MISSING.y)
      return Promise.resolve(new Response(null, { status: 404 }));
    return Promise.resolve(new Response(new Uint8Array(terrainTile(fixtureTile(coord(level, x, y)), encoding))));
  };
}

function decodePng(bytes: Uint8Array): { rgba: Uint8Array; sizePx: number } {
  const png = PNG.sync.read(Buffer.from(bytes));
  return { rgba: new Uint8Array(png.data), sizePx: png.width };
}

function heightmapSubject(encoding: 'terrarium' | 'terrain-rgb', precisionMeters: number): TerrainConformanceSubject {
  const fixture = service(encoding);
  return {
    name: encoding,
    create: (fetchImpl) =>
      heightmapTerrain({
        id: encoding,
        url: 'https://terrain.test/{z}/{x}/{y}.png',
        encoding,
        maxLevel: 8,
        // The eastern hemisphere, north of the equator: the test tiles lie inside, 6/10/28 outside.
        coverage: [{ westRad: 0, southRad: 0, eastRad: Math.PI, northRad: 85 * DEG }],
        transport: fetchTransport(fetchImpl),
        attribution: ATTRIBUTION,
        profile: CUSTOM_PROFILE,
      }),
    fixture,
    tiles: TILES.map((c) => ({ coord: c, bytes: new Uint8Array(terrainTile(fixtureTile(c), encoding)) })),
    missing: [MISSING],
    outside: [coord(6, 10, 28)],
    heights: references(precisionMeters + 0.5),
    decodeImage: decodePng,
  };
}

describe('terrain adapters on the shared conformance suite (F235)', () => {
  it('the Terrarium adapter passes, heights within 1/256 m plus interpolation', async () => {
    expect(failures(await runTerrainConformance(heightmapSubject('terrarium', 1 / 256)))).toEqual([]);
  });

  it('the Terrain-RGB adapter passes, heights within 0.1 m plus interpolation', async () => {
    expect(failures(await runTerrainConformance(heightmapSubject('terrain-rgb', 0.1)))).toEqual([]);
  });

  it('the quantized-mesh adapter passes, heights within its quantization plus interpolation', async () => {
    const fixture = service('quantized-mesh');
    const results = await runTerrainConformance({
      name: 'quantized-mesh',
      // layer.json is read while the source opens; the faults then hit the tiles.
      create: (fetchImpl) =>
        quantizedMeshTerrain({
          id: 'quantized-mesh',
          url: 'https://terrain.test/layer.json',
          fetchImpl,
          attribution: ATTRIBUTION,
        }),
      fixture,
      tiles: TILES.map((c) => ({
        coord: c,
        bytes: new Uint8Array(terrainTile(fixtureTile(c), 'quantized-mesh')),
      })),
      missing: [MISSING],
      // The western hemisphere, which layer.json leaves out from level 5.
      outside: [coord(6, 10, 28)],
      // The fixture quantizes about 600 m of relief to 15 bits (≈ 0.02 m).
      heights: references(0.5),
    });
    expect(failures(results)).toEqual([]);
  });

  it('reports a terrain adapter whose heights are wrong', async () => {
    const subject = heightmapSubject('terrarium', 1 / 256);
    // Terrain-RGB bytes decoded as Terrarium: every height is far off.
    const wrong = await runTerrainConformance({ ...subject, fixture: service('terrain-rgb'), tiles: [] });
    expect(failures(wrong).filter((line) => line.includes('heights')).length).toBe(4);
  });
});

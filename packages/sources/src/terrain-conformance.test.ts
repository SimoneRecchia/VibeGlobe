import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { decodeHeightmap, type ImagerySource, type TerrainSource, type TileCoord } from '@vibeglobe/core';
import { decodeQuantizedMesh } from '@vibeglobe/core/decoders';
import { fixturePosition, type FixtureTile } from '../../../scripts/fixtures/tiles/generate.ts';
import { fixtureHeightMeters, terrainTile } from '../../../scripts/fixtures/tiles/terrain.ts';
import { failures, runTiledConformance } from './conformance/index.js';
import { fetchTransport } from './fetch-transport.js';
import { heightmapTerrain } from './heightmap-terrain.js';
import { CUSTOM_PROFILE } from './metadata.js';
import { quantizedMeshTerrain } from './quantized-mesh-terrain.js';

/** The terrain adapters against the shared conformance suite with the fixture terrain (F235). */
const coord = (level: number, x: number, y: number): TileCoord => ({ root: 0, level, x, y });
const TILES = [coord(6, 34, 23), coord(2, 2, 1), coord(9, 270, 171)];
const MISSING = coord(6, 34, 22);
const ATTRIBUTION = [{ text: '© Fixture terrain' }];
type Encoding = 'terrarium' | 'terrain-rgb' | 'quantized-mesh';

const fixtureTile = (c: TileCoord): FixtureTile => ({ pattern: 'world', scheme: 'mercator', ...c });
const bytesOf = (c: TileCoord, encoding: Encoding): Uint8Array => new Uint8Array(terrainTile(fixtureTile(c), encoding));

/** The fixture service: heightmap PNGs by XYZ rows, quantized-mesh tiles by TMS rows under a `layer.json`. */
const service: typeof fetch = (input) => {
  const url = String(input);
  if (url.endsWith('/qm/layer.json'))
    return Promise.resolve(
      Response.json({
        tilejson: '2.1.0',
        format: 'quantized-mesh-1.0',
        scheme: 'tms',
        tiles: ['{z}/{x}/{y}.terrain'],
        projection: 'EPSG:3857',
        minzoom: 0,
        maxzoom: 12,
        available: Array.from({ length: 13 }, (_, z) => [{ startX: 0, startY: 0, endX: 2 ** z - 1, endY: 2 ** z - 1 }]),
      }),
    );
  const match = /\/(terrarium|terrain-rgb|qm)\/(\d+)\/(\d+)\/(\d+)\.(png|terrain)$/.exec(url);
  if (!match) return Promise.resolve(new Response(null, { status: 404 }));
  const [, kind = '', z = '0', x = '0', row = '0'] = match;
  const level = Number(z);
  const y = kind === 'qm' ? 2 ** level - 1 - Number(row) : Number(row);
  const c = coord(level, Number(x), y);
  if (c.level === MISSING.level && c.x === MISSING.x && c.y === MISSING.y)
    return Promise.resolve(new Response(null, { status: 404 }));
  const encoding: Encoding = kind === 'qm' ? 'quantized-mesh' : (kind as Encoding);
  return Promise.resolve(new Response(bytesOf(c, encoding).slice()));
};

/**
 * A terrain source seen by the tiled suite, which reads imagery fields: the heightmap's tile size, and the profile of a
 * source whose owner set no provider rules.
 */
function asTiled(source: TerrainSource): ImagerySource {
  return { ...source, tileSizePx: 256, pixelRatio: 1, profile: CUSTOM_PROFILE } as unknown as ImagerySource;
}

async function create(encoding: Encoding, fetchImpl: typeof fetch): Promise<ImagerySource> {
  if (encoding === 'quantized-mesh')
    return asTiled(
      await quantizedMeshTerrain({
        id: 'qm',
        url: 'https://t.test/qm/layer.json',
        fetchImpl,
        attribution: ATTRIBUTION,
      }),
    );
  return asTiled(
    heightmapTerrain({
      id: encoding,
      url: `https://t.test/${encoding}/{z}/{x}/{y}.png`,
      encoding,
      maxLevel: 12,
      transport: fetchTransport(fetchImpl),
      attribution: ATTRIBUTION,
    }),
  );
}

describe('terrain adapters pass the shared conformance suite (F235)', () => {
  for (const encoding of ['terrarium', 'terrain-rgb', 'quantized-mesh'] as const) {
    it(`${encoding}: metadata, addressing, coverage, zoom range, errors, cancellation and attribution`, async () => {
      const results = await runTiledConformance({
        name: encoding,
        create: (fetchImpl) => create(encoding, fetchImpl),
        fixture: service,
        tiles: TILES.map((c) => ({ coord: c, bytes: bytesOf(c, encoding) })),
        missing: [MISSING],
      });
      expect(failures(results)).toEqual([]);
      const areas = new Set(results.map((result) => result.area));
      for (const area of ['metadata', 'addressing', 'zoom range', 'error handling', 'cancellation', 'attribution'])
        expect(areas).toContain(area);
    });
  }

  it('decodes heights at test coordinates within each encoding’s precision', () => {
    const tile = coord(9, 270, 171);
    const fixture = fixtureTile(tile);
    for (const [encoding, precisionMeters] of [
      ['terrarium', 1 / 256],
      ['terrain-rgb', 0.1],
    ] as const) {
      const png = PNG.sync.read(Buffer.from(bytesOf(tile, encoding)));
      const heights = decodeHeightmap(new Uint8Array(png.data), 256, encoding);
      for (const [i, j] of [
        [0, 0],
        [17, 200],
        [128, 128],
        [255, 3],
      ] as const) {
        const { lonRad, latRad } = fixturePosition(fixture, (i + 0.5) / 256, (j + 0.5) / 256);
        expect(Math.abs((heights[j * 256 + i] ?? 0) - fixtureHeightMeters(lonRad, latRad))).toBeLessThanOrEqual(
          precisionMeters / 2 + 1e-6,
        );
      }
    }
    // Quantized-mesh vertices: heights quantized to 1/32767 of the tile's height range, at their own positions.
    const mesh = decodeQuantizedMesh(bytesOf(tile, 'quantized-mesh'));
    const step = (mesh.maxHeightMeters - mesh.minHeightMeters) / 32767;
    for (let k = 0; k < mesh.u.length; k += 97) {
      const { lonRad, latRad } = fixturePosition(fixture, mesh.u[k] ?? 0, 1 - (mesh.v[k] ?? 0));
      expect(Math.abs((mesh.heightsMeters[k] ?? 0) - fixtureHeightMeters(lonRad, latRad))).toBeLessThanOrEqual(
        step + 1e-6,
      );
    }
  });
});

// F219: a consumer's custom terrain, vector and 3D adapters, written against the public engine API only, pass the
// shared suites and deliver their content at the expected coordinates (the imagery adapter: quadkey-imagery.test.ts).
import { ecefToGeodetic, type TileCoord } from '@vibeglobe/core';
import { fetchTransport } from '@vibeglobe/sources';
import { failures, runParserConformance, runTerrainConformance } from '@vibeglobe/sources/conformance';
import { parseTileContent, parseTileset } from '@vibeglobe/sources/tiles3d';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fixturePosition, type FixtureTile } from '../tiles/generate.ts';
import { fixtureHeightMeters, terrainTile } from '../tiles/terrain.ts';
import { envelopeTransport } from './envelope-3d-transport.ts';
import { quadkey } from './quadkey-imagery.ts';
import { quadkeyTerrain } from './quadkey-terrain.ts';
import { parseTrackList } from './track-list-vector.ts';

const DEG = Math.PI / 180;
const coord = (level: number, x: number, y: number): TileCoord => ({ root: 0, level, x, y });
const fixtureTile = (c: TileCoord): FixtureTile => ({
  pattern: 'terrain' as FixtureTile['pattern'],
  scheme: 'mercator',
  ...c,
});

describe('custom adapters outside packages/ (F219)', () => {
  it('the quadkey terrain adapter passes the shared terrain suite with the heights of the fixture', async () => {
    const tiles = [coord(6, 40, 28), coord(5, 20, 14)];
    const missing = coord(6, 41, 28);
    const keys = new Map(tiles.map((c) => [quadkey(c), c]));
    const service: typeof fetch = (input) => {
      const tile = keys.get(/\/(\d+)\.f32$/.exec(String(input))?.[1] ?? '');
      return Promise.resolve(
        tile
          ? new Response(new Uint8Array(terrainTile(fixtureTile(tile), 'float32')))
          : new Response(null, { status: 404 }),
      );
    };
    const heights = tiles.flatMap((c) =>
      [
        [0.5, 0.5],
        [0.125, 0.75],
      ].map(([u = 0, v = 0]) => {
        const { lonRad, latRad } = fixturePosition(fixtureTile(c), u, v);
        return { coord: c, u, v, meters: fixtureHeightMeters(lonRad, latRad), toleranceMeters: 0.5 };
      }),
    );
    const results = await runTerrainConformance({
      name: 'quadkey terrain (custom package)',
      create: (fetchImpl) => quadkeyTerrain(fetchTransport(fetchImpl)),
      fixture: service,
      tiles: tiles.map((c) => ({ coord: c, bytes: new Uint8Array(terrainTile(fixtureTile(c), 'float32')) })),
      missing: [missing],
      heights,
    });
    expect(failures(results)).toEqual([]);
  });

  it('the track list vector adapter passes the shared parser suite and parses features at their coordinates', async () => {
    const document =
      '# fixture logger\npoint colosseum 41.8902,12.4922,21\ntrack walk 41.8902,12.4922 41.8986,12.4769\n';
    const results = await runParserConformance({
      name: 'track list (custom package)',
      parse: parseTrackList,
      fixtures: [
        {
          name: 'a point and a track',
          input: document,
          expect: (parsed) =>
            parsed.features.length === 2 && parsed.issues.length === 0 ? undefined : JSON.stringify(parsed),
        },
        {
          name: 'a bad record is an issue',
          input: 'point nowhere 91,0\n',
          expect: (parsed) => (parsed.features.length === 0 && parsed.issues.length === 1 ? undefined : 'no issue'),
        },
      ],
    });
    expect(failures(results)).toEqual([]);
    const { features } = parseTrackList(document);
    expect(features[0]?.geometry).toEqual({ type: 'Point', coordinates: [12.4922, 41.8902, 21] });
    expect(features[1]?.geometry).toEqual({
      type: 'LineString',
      coordinates: [
        [12.4922, 41.8902],
        [12.4769, 41.8986],
      ],
    });
  });

  it('the envelope 3D transport delivers a tileset and its content, placed at the expected coordinates', async () => {
    const files = new Map<string, Uint8Array>([
      [
        'city/tileset.json',
        new TextEncoder().encode(
          JSON.stringify({
            asset: { version: '1.1' },
            geometricError: 100,
            root: {
              // Around the Colosseum, 0 to 50 m above the ellipsoid.
              boundingVolume: { region: [12.49 * DEG, 41.888 * DEG, 12.494 * DEG, 41.892 * DEG, 0, 50] },
              geometricError: 0,
              content: { uri: 'tiles/root.b3dm' },
            },
          }),
        ),
      ],
      ['city/tiles/root.b3dm', readFileSync('packages/sources/src/__fixtures__/tiles3d/discrete-lod/dragon_low.b3dm')],
    ]);
    const service: typeof fetch = (input) => {
      const file = new URL(String(input)).searchParams.get('file') ?? '';
      const bytes = files.get(file);
      return Promise.resolve(
        bytes ? Response.json({ base64: Buffer.from(bytes).toString('base64') }) : new Response(null, { status: 404 }),
      );
    };
    const transport = envelopeTransport('https://envelopes.test/', fetchTransport(service));
    const get = (url: string) =>
      new Promise<ArrayBuffer>((resolve, reject) =>
        transport.start({ url, hostIndex: 0 }, { firstByteMs: 5000, totalMs: 5000 }, (result) =>
          result.kind === 'ok' ? resolve(result.bytes) : reject(new Error(result.kind)),
        ),
      );
    const url = 'https://envelopes.test/city/tileset.json';
    const { tileset, problems } = parseTileset(JSON.parse(new TextDecoder().decode(await get(url))), url);
    expect(problems).toEqual([]);
    const root = tileset?.root;
    const center = root?.volume.center ?? [];
    const place = ecefToGeodetic(center[0] ?? 0, center[1] ?? 0, center[2] ?? 0, {
      longitudeRad: 0,
      latitudeRad: 0,
      heightMeters: 0,
    });
    expect(place.longitudeRad / DEG).toBeCloseTo(12.492, 3);
    expect(place.latitudeRad / DEG).toBeCloseTo(41.89, 3);
    const contentUrl = root?.contents[0]?.uri ?? '';
    expect(contentUrl).toBe('https://envelopes.test/city/tiles/root.b3dm');
    expect(parseTileContent(await get(contentUrl)).type).toBe('b3dm');
  });
});

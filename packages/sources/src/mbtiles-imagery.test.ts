import { describe, expect, it } from 'vitest';
import type { TileCoord, TransportResult } from '@vibeglobe/core';
import { failures, mutate, runTiledConformance } from './conformance/index.js';
import { writeMbtiles } from './__fixtures__/mbtiles-writer.js';
import { mbtilesImagery } from './mbtiles-imagery.js';
import { SourceConfigError } from './metadata.js';

const URL = 'http://nas.local/italy.mbtiles';
const encoder = new TextEncoder();
const coord = (level: number, x: number, y: number): TileCoord => ({ root: 0, level, x, y });

/** Levels 2–4 over Italy, where two tiles share their content (deduplicated in the map/images schema). */
function italy(): Map<string, Uint8Array> {
  const tiles = new Map<string, Uint8Array>();
  for (const [z, x0, x1, y0, y1] of [
    [2, 2, 2, 1, 1],
    [3, 4, 4, 2, 3],
    [4, 8, 8, 5, 6],
  ] as const)
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++) tiles.set(`${z}/${x}/${y}`, encoder.encode(`tile ${z}/${x}/${y}`));
  tiles.set('4/8/6', encoder.encode('tile 4/8/5'));
  return tiles;
}

const METADATA = {
  name: 'Italy',
  format: 'png',
  bounds: '6,36,19,47.5',
  minzoom: '2',
  maxzoom: '4',
  attribution: '<a href="https://data.test">© Data</a>',
};

function serve(bytes: Uint8Array): typeof fetch {
  return (input) =>
    Promise.resolve(String(input) === URL ? new Response(bytes.slice()) : new Response(null, { status: 404 }));
}

function fetchVia(
  source: Awaited<ReturnType<typeof mbtilesImagery>>,
  c: TileCoord,
): Promise<TransportResult | 'noData'> {
  const request = source.request(c, { url: '', hostIndex: 0 });
  if (request === 'noData' || request === 'unknown') return Promise.resolve('noData');
  return new Promise((resolve) => source.transport.start(request, { firstByteMs: 1000, totalMs: 2000 }, resolve));
}

describe('mbtilesImagery (F233)', () => {
  it.each(['plain', 'deduplicated'] as const)('passes the tiled conformance suite on the %s schema', async (schema) => {
    const tiles = italy();
    const bytes = await writeMbtiles(tiles, METADATA, schema);
    const results = await runTiledConformance({
      name: `mbtiles ${schema}`,
      network: 'on-open',
      create: (fetchImpl) => mbtilesImagery({ id: 'it', package: URL, fetch: fetchImpl, downloadTimeoutMs: 200 }),
      fixture: serve(bytes),
      tiles: [coord(2, 2, 1), coord(3, 4, 3), coord(4, 8, 6)].map((c) => ({
        coord: c,
        bytes: tiles.get(`${c.level}/${c.x}/${c.y}`),
      })),
      missing: [coord(4, 9, 5)],
      outside: [coord(3, 1, 3)],
    });
    expect(failures(results)).toEqual([]);
  });

  it('reads bounds, levels, format and attribution, and maps XYZ rows to TMS rows', async () => {
    const source = await mbtilesImagery({
      id: 'it',
      package: URL,
      fetch: serve(await writeMbtiles(italy(), METADATA)),
    });
    expect([source.minLevel, source.maxLevel]).toEqual([2, 4]);
    expect(source.attribution).toEqual([{ text: '© Data', url: 'https://data.test' }]);
    const tile = await fetchVia(source, coord(3, 4, 2));
    expect(tile !== 'noData' && tile.kind === 'ok' && new TextDecoder().decode(tile.bytes)).toBe('tile 3/4/2');
    expect(tile !== 'noData' && tile.kind === 'ok' && tile.contentType).toBe('image/png');
    // Without zoom metadata the levels come from the tiles themselves.
    const bare = await mbtilesImagery({ id: 'b', package: new Blob([await writeMbtiles(italy(), { format: 'jpg' })]) });
    expect([bare.minLevel, bare.maxLevel, bare.coverage]).toEqual([2, 4, undefined]);
  });

  it('reads the same tiles from a local file and from a server', async () => {
    const bytes = await writeMbtiles(italy(), METADATA, 'deduplicated');
    const remote = await mbtilesImagery({ id: 'r', package: URL, fetch: serve(bytes) });
    const local = await mbtilesImagery({ id: 'l', package: new Blob([bytes]) });
    for (const key of italy().keys()) {
      const [z = 0, x = 0, y = 0] = key.split('/').map(Number);
      expect(await fetchVia(local, coord(z, x, y))).toEqual(await fetchVia(remote, coord(z, x, y)));
    }
  });

  it('refuses corrupted packages with a descriptive error and never throws otherwise', async () => {
    const bytes = await writeMbtiles(italy(), METADATA);
    let state = 11;
    const random = (): number => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 4294967296;
    };
    for (let run = 0; run < 60; run++) {
      let source;
      try {
        source = await mbtilesImagery({ id: `f${run}`, package: new Blob([mutate(bytes, random)]) });
      } catch (error) {
        expect(error).toBeInstanceOf(SourceConfigError);
        expect((error as Error).message).toContain(`'f${run}'`);
        continue;
      }
      const result = await fetchVia(source, coord(3, 4, 3));
      expect(result === 'noData' || ['ok', 'status'].includes(result.kind)).toBe(true);
    }
  });
});

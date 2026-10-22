import { describe, expect, it } from 'vitest';
import type { TileCoord, TransportResult } from '@vibeglobe/core';
import { failures, mutate, runTiledConformance } from './conformance/index.js';
import { type ArchiveOptions, rangeServer, writePmtiles } from './__fixtures__/pmtiles-writer.js';
import { SourceConfigError } from './metadata.js';
import { pmtilesImagery } from './pmtiles-imagery.js';

const URL = 'https://tiles.test/world.pmtiles';
const encoder = new TextEncoder();

/** Every tile of levels 0–3 except 3/1/1, with its key as its bytes. */
function pyramid(): Map<string, Uint8Array> {
  const tiles = new Map<string, Uint8Array>();
  for (let z = 0; z <= 3; z++)
    for (let x = 0; x < 2 ** z; x++)
      for (let y = 0; y < 2 ** z; y++)
        if (`${z}/${x}/${y}` !== '3/1/1') tiles.set(`${z}/${x}/${y}`, encoder.encode(`tile ${z}/${x}/${y}`));
  return tiles;
}

const coord = (level: number, x: number, y: number): TileCoord => ({ root: 0, level, x, y });

function fetchVia(
  source: Awaited<ReturnType<typeof pmtilesImagery>>,
  c: TileCoord,
): Promise<TransportResult | 'noData'> {
  const request = source.request(c, { url: '', hostIndex: 0 });
  if (request === 'noData' || request === 'unknown') return Promise.resolve('noData');
  return new Promise((resolve) => source.transport.start(request, { firstByteMs: 1000, totalMs: 2000 }, resolve));
}

const VARIANTS: [string, ArchiveOptions][] = [
  ['clustered, gzip directories', {}],
  ['unclustered, plain directories', { clustered: false, gzipDirectories: false }],
  ['clustered, leaf directories', { leafSize: 7 }],
  ['unclustered, gzip leaf directories', { clustered: false, leafSize: 5 }],
];

describe('pmtilesImagery (F232)', () => {
  it.each(VARIANTS)('passes the tiled conformance suite on a %s archive', async (_, options) => {
    const tiles = pyramid();
    const archive = writePmtiles(tiles, {
      ...options,
      metadata: { attribution: '<a href="https://data.test">© Data</a>' },
    });
    const server = rangeServer(URL, archive);
    const results = await runTiledConformance({
      name: `pmtiles ${_}`,
      create: (fetchImpl) => pmtilesImagery({ id: 'pm', archive: URL, fetch: fetchImpl }),
      fixture: server.fetch,
      tiles: [coord(0, 0, 0), coord(2, 1, 3), coord(3, 7, 7), coord(3, 0, 5)].map((c) => ({
        coord: c,
        bytes: tiles.get(`${c.level}/${c.x}/${c.y}`),
      })),
      missing: [coord(3, 1, 1)],
    });
    expect(failures(results)).toEqual([]);
  });

  it('reads levels, coverage and attribution from the archive, and refuses vector archives', async () => {
    const archive = writePmtiles(pyramid(), {
      bounds: [6, 36, 19, 47.5],
      metadata: { attribution: '<a href="https://data.test">© Data</a>' },
    });
    const source = await pmtilesImagery({ id: 'it', archive: URL, fetch: rangeServer(URL, archive).fetch });
    expect([source.minLevel, source.maxLevel]).toEqual([0, 3]);
    expect(source.attribution).toEqual([{ text: '© Data', url: 'https://data.test' }]);
    // Level 3: Italy lies in column 4, row 2; the Americas (column 1) are outside the coverage.
    expect(source.request(coord(3, 4, 2), { url: '', hostIndex: 0 })).not.toBe('noData');
    expect(source.request(coord(3, 1, 2), { url: '', hostIndex: 0 })).toBe('noData');
    const vector = writePmtiles(pyramid(), { tileType: 1 });
    await expect(pmtilesImagery({ id: 'v', archive: URL, fetch: rangeServer(URL, vector).fetch })).rejects.toThrow(
      SourceConfigError,
    );
  });

  it('fetches the header and each directory once, and tiles with range requests', async () => {
    const server = rangeServer(URL, writePmtiles(pyramid(), { leafSize: 6 }));
    const source = await pmtilesImagery({ id: 'pm', archive: URL, fetch: server.fetch });
    const wanted = [...pyramid().keys()].map((k) => k.split('/').map(Number) as [number, number, number]);
    await Promise.all(wanted.map(([z, x, y]) => fetchVia(source, coord(z, x, y))));
    await Promise.all(wanted.slice(0, 10).map(([z, x, y]) => fetchVia(source, coord(z, x, y))));
    const ranges = server.requests.map((r) => r.split(' ')[1] ?? '');
    expect(ranges.every((r) => r.startsWith('bytes='))).toBe(true);
    expect(ranges.filter((r) => r.startsWith('bytes=0-')).length).toBe(1);
    const leafReads = new Set(ranges);
    // Header, metadata, 15 leaves (84 tiles / 6), 84 + 10 tile reads: no directory is read twice.
    expect(leafReads.size).toBe(ranges.length - 10);
  });

  it('reads the same tiles from a local Blob', async () => {
    const archive = writePmtiles(pyramid(), { clustered: false, leafSize: 4 });
    const remote = await pmtilesImagery({ id: 'r', archive: URL, fetch: rangeServer(URL, archive).fetch });
    const local = await pmtilesImagery({ id: 'l', archive: new Blob([archive]) });
    for (const c of [coord(0, 0, 0), coord(2, 3, 1), coord(3, 5, 6), coord(3, 1, 1)]) {
      const [a, b] = await Promise.all([fetchVia(remote, c), fetchVia(local, c)]);
      expect(b).toEqual(a);
    }
  });

  it('never throws on corrupted archives: they are refused or their tiles are no data', async () => {
    const archive = writePmtiles(pyramid(), { leafSize: 6 });
    let random = 7;
    const next = (): number => {
      random = (random * 1664525 + 1013904223) >>> 0;
      return random / 4294967296;
    };
    for (let run = 0; run < 150; run++) {
      const broken = mutate(archive, next);
      let source;
      try {
        source = await pmtilesImagery({ id: `f${run}`, archive: new Blob([broken]) });
      } catch (error) {
        expect(error).toBeInstanceOf(SourceConfigError);
        continue;
      }
      const result = await fetchVia(source, coord(Math.min(source.maxLevel, 2), 1, 1));
      expect(result === 'noData' || ['ok', 'status'].includes(result.kind)).toBe(true);
    }
  });
});

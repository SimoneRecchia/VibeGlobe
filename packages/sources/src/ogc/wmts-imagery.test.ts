import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { WEB_MERCATOR_TILING, type TileCoord, type TransportResult } from '@vibeglobe/core';
import { transformCoordinates } from '@vibeglobe/gis';
import { failures, runParserConformance, runTiledConformance } from '../conformance/index.js';
import { fetchTransport } from '../fetch-transport.js';
import { SourceConfigError } from '../metadata.js';
import { parseWmtsCapabilities } from './wmts-capabilities.js';
import { wmtsImagery } from './wmts-imagery.js';
import { wmtsParts } from './wmts-reprojected.js';

const fixture = (name: string): string =>
  readFileSync(new URL(`../__fixtures__/capabilities/${name}`, import.meta.url), 'utf8');
const OGC = fixture('wmts-ogc-sample.xml');
const ARCGIS = fixture('wmts-arcgis.xml');
const WGS84 = fixture('wmts-wgs84.xml');
const SYNTHETIC = fixture('wmts-synthetic.xml');
const coord = (level: number, x: number, y: number): TileCoord => ({ root: 0, level, x, y });
const blank = () => ({ url: '', hostIndex: 0 });
const never = fetchTransport(() => new Promise<Response>(() => undefined));

describe('parseWmtsCapabilities (F230)', () => {
  it('reads layers, styles, formats, dimensions, resource URLs and the KVP endpoint of the OGC sample', () => {
    const caps = parseWmtsCapabilities(OGC);
    const layer = caps.layers[0];
    expect(layer?.identifier).toBe('BlueMarbleNextGeneration');
    expect(layer?.styles).toEqual([
      { identifier: 'DarkBlue', isDefault: true },
      { identifier: 'thickAndRed', isDefault: false },
    ]);
    expect(layer?.formats).toEqual(['image/jpeg', 'image/gif']);
    expect(layer?.tileMatrixSetLinks.map((l) => l.set)).toEqual(['BigWorldPixel', 'google3857', 'google3857subset']);
    expect(layer?.resourceUrls[0]?.template).toBe(
      'http://www.example.com/wmts/coastlines/{TileMatrix}/{TileRow}/{TileCol}.png',
    );
    expect(layer?.dimensions[0]?.identifier).toBe('Time');
    expect(caps.kvpUrl).toMatch(/^http/);
    expect(caps.tileMatrixSets.find((s) => s.identifier === 'google3857')?.matrices.length).toBeGreaterThan(10);
  });

  it('reads tile matrices, limits and the provider of the recorded and synthetic documents', () => {
    const arcgis = parseWmtsCapabilities(ARCGIS);
    expect(arcgis.tileMatrixSets.map((s) => [s.identifier, s.crs])).toEqual([
      ['default028mm', 'EPSG:3857'],
      ['GoogleMapsCompatible', 'EPSG:3857'],
    ]);
    expect(arcgis.layers[0]?.wgs84Bounds?.[0]).toBeCloseTo(-178.2278, 3);
    const wgs = parseWmtsCapabilities(WGS84);
    expect(wgs.tileMatrixSets[0]?.matrices[0]).toMatchObject({
      topLeftCorner: [90, -180],
      matrixWidth: 2,
      matrixHeight: 1,
    });
    const synthetic = parseWmtsCapabilities(SYNTHETIC);
    expect(synthetic.title).toBe('Synthetic & edge cases');
    expect(synthetic.provider).toEqual({ name: 'Fixture Agency', url: 'https://agency.test/' });
    expect(synthetic.kvpUrl).toBe('https://wmts.test/service?token=abc&');
    const limits = synthetic.layers[0]?.tileMatrixSetLinks[1]?.limits;
    expect(limits?.get('m4')).toEqual({ minRow: 5, maxRow: 6, minCol: 8, maxCol: 9 });
  });

  it('refuses malformed documents with a descriptive error and never crashes on fuzzed ones', async () => {
    await expect(wmtsImagery({ id: 'bad', capabilities: '<html><body/></html>', layer: 'x' })).rejects.toThrow(
      /'bad'.*Capabilities/,
    );
    await expect(
      wmtsImagery({ id: 'bad', capabilities: '<Capabilities><Contents><Layer>', layer: 'x' }),
    ).rejects.toThrow(SourceConfigError);
    const results = await runParserConformance({
      name: 'wmts capabilities',
      parse: async (xml: string) => {
        try {
          return await wmtsImagery({ id: 'fuzz', capabilities: `${xml}`, layer: 'ortho', transport: never });
        } catch (error) {
          if (error instanceof SourceConfigError) return error;
          throw error;
        }
      },
      fixtures: [SYNTHETIC, OGC, ARCGIS].map((xml, i) => ({
        name: `document ${i}`,
        input: xml,
        expect: () => undefined,
      })),
    });
    expect(failures(results)).toEqual([]);
  });
});

describe('wmtsImagery (F230, F227)', () => {
  it('builds RESTful requests with style, dimension and matrix limits on a 512-pixel Web Mercator set', async () => {
    const source = await wmtsImagery({ id: 'w', capabilities: SYNTHETIC, layer: 'ortho', transport: never });
    expect([source.tiling.crs, source.tileSizePx, source.minLevel, source.maxLevel]).toEqual(['EPSG:3857', 512, 2, 5]);
    expect(source.request(coord(4, 8, 5), blank())).toEqual({
      url: 'https://wmts.test/rest/ortho/default/2024/WebMercator512/m4/5/8.png',
      hostIndex: 0,
    });
    expect(source.request(coord(4, 10, 5), blank())).toBe('noData');
    expect(source.request(coord(1, 1, 0), blank())).toBe('noData');
    expect(source.attribution).toEqual([{ text: 'Fixture Agency', url: 'https://agency.test/' }]);
  });

  it('builds KVP requests with every parameter when asked', async () => {
    const source = await wmtsImagery({
      id: 'k',
      capabilities: SYNTHETIC,
      layer: 'ortho',
      encoding: 'KVP',
      style: 'natural',
      format: 'image/jpeg',
      dimensions: { Time: '2023' },
      transport: never,
    });
    const request = source.request(coord(3, 4, 2), blank());
    expect(typeof request === 'object' && request.url).toBe(
      'https://wmts.test/service?token=abc&SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ortho&STYLE=natural' +
        '&FORMAT=image%2Fjpeg&TILEMATRIXSET=WebMercator512&Time=2023&TILEMATRIX=m3&TILEROW=2&TILECOL=4',
    );
  });

  it('requests EPSG:3857 or EPSG:4326 directly instead of the UTM set, honoring the preference (F227)', async () => {
    const geographic = await wmtsImagery({
      id: 'g',
      capabilities: SYNTHETIC,
      layer: 'ortho',
      preferredCrs: 'EPSG:4326',
      transport: never,
    });
    expect([geographic.tiling.crs, geographic.minLevel, geographic.maxLevel]).toEqual(['EPSG:4326', 0, 2]);
    const request = geographic.request(coord(2, 4, 1), blank());
    expect(typeof request === 'object' && request.url).toContain('/EPSG%3A4326/EPSG%3A4326%3A2/1/4.png');
    const recorded = await wmtsImagery({
      id: 'a',
      capabilities: ARCGIS,
      layer: 'Demographics_USA_Population_Density',
      transport: never,
    });
    const tile = recorded.request(coord(3, 2, 3), blank());
    expect(typeof tile === 'object' && tile.url).toContain('/default/GoogleMapsCompatible/3/3/2.png');
    await expect(wmtsImagery({ id: 'u', capabilities: SYNTHETIC, layer: 'utm-only' })).rejects.toThrow(/reprojection/);
    const inspire = await wmtsImagery({ id: 'i', capabilities: WGS84, layer: 'baselayer', transport: never });
    expect(inspire.tiling.crs).toBe('EPSG:4326');
  });

  it('reprojects a UTM-only layer on the client, composing its tiles in place, but not a layer with a matching set (F227)', async () => {
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
    const direct = await wmtsImagery({
      id: 'd',
      capabilities: SYNTHETIC,
      layer: 'ortho',
      transforms,
      transport: never,
    });
    const tile = direct.request(coord(2, 2, 1), blank());
    expect(typeof tile === 'object' && tile.url).toContain('WebMercator512');
    const urls: string[] = [];
    const source = await wmtsImagery({
      id: 'u',
      capabilities: SYNTHETIC,
      layer: 'utm-only',
      transforms,
      transport: fetchTransport((input) => {
        urls.push(String(input));
        return Promise.resolve(new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/png' } }));
      }),
    });
    expect([source.tiling.crs, source.transparent]).toEqual(['EPSG:3857', true]);
    const c = WEB_MERCATOR_TILING.tileAt((9.19 * Math.PI) / 180, (45.46 * Math.PI) / 180, 6, coord(0, 0, 0));
    const request = source.request(c, blank());
    if (typeof request !== 'object') throw new Error('no request');
    // The composition and warp need a browser (e2e reprojection.spec.ts, F226); here they settle as no data.
    const result = await new Promise<TransportResult>((resolve) =>
      source.transport.start({ url: request.url, hostIndex: 0 }, { firstByteMs: 1000, totalMs: 1000 }, resolve),
    );
    expect(result.kind).toBe('ok');
    // The u0 matrix: 256 km tiles from (200 km E, 5300 km N); Milan (514.9 km E, 5034.5 km N) is in row 1, column 1.
    const tiles = urls.map((u) => {
      const q = new URL(u).searchParams;
      return [q.get('TILEMATRIXSET'), q.get('TILEMATRIX'), Number(q.get('TILEROW')), Number(q.get('TILECOL'))];
    });
    expect(tiles).toContainEqual(['utm32', 'u0', 1, 1]);
    for (const [, , row, col] of tiles) {
      expect(row).toBeLessThan(4);
      expect(col).toBeLessThan(3);
    }
  });

  it('places each composed tile at its source position in the image (F227)', () => {
    const set = parseWmtsCapabilities(SYNTHETIC).tileMatrixSets.find((s) => s.identifier === 'utm32');
    if (!set) throw new Error('no set');
    const bbox = [400_000, 4_900_000, 600_000, 5_100_000] as const;
    const parts = wmtsParts(set.matrices, new Map(), (m, r, c) => `${m}/${r}/${c}`, bbox, 400, 400);
    // 200 km at 500 m per pixel; u0's 256 km tiles from (200 km, 5300 km): columns 0–1, rows 0–1.
    expect(parts.map((p) => p.url)).toEqual(['u0/0/0', 'u0/0/1', 'u0/1/0', 'u0/1/1']);
    for (const p of parts) {
      const [, row, col] = p.url.split('/').map(Number);
      // Pixel → source: the part's left and top edges are its tile's, at 500 m per pixel (tiles of 3571428.57 × 0.28 mm × 256 ≈ 256 km).
      expect(bbox[0] + p.xPx * 500).toBeCloseTo(200_000 + (col ?? NaN) * 256_000, 3);
      expect(bbox[3] - p.yPx * 500).toBeCloseTo(5_300_000 - (row ?? NaN) * 256_000, 3);
      expect(p.widthPx).toBeCloseTo(512, 3);
      expect(p.heightPx).toBeCloseTo(512, 3);
    }
    const limited = wmtsParts(
      set.matrices,
      new Map([['u0', { minRow: 1, maxRow: 1, minCol: 0, maxCol: 2 }]]),
      (m, r, c) => `${m}/${r}/${c}`,
      bbox,
      400,
      400,
    );
    expect(limited.map((p) => p.url)).toEqual(['u0/1/0', 'u0/1/1']);
  });

  it('passes the tiled conformance suite', async () => {
    const bytes = new TextEncoder().encode('png');
    const service: typeof fetch = (input) => {
      const url = String(input);
      if (/\/m\d\/\d+\/\d+\.png$/.test(url) && !url.endsWith('/m5/11/17.png'))
        return Promise.resolve(new Response(bytes.slice()));
      return Promise.resolve(new Response(null, { status: 404 }));
    };
    const results = await runTiledConformance({
      name: 'wmts',
      create: (fetchImpl) =>
        wmtsImagery({ id: 'w', capabilities: SYNTHETIC, layer: 'ortho', transport: fetchTransport(fetchImpl) }),
      fixture: service,
      tiles: [coord(4, 8, 5), coord(2, 2, 1)].map((c) => ({ coord: c, bytes })),
      missing: [coord(5, 17, 11)],
      outside: [coord(3, 1, 3), coord(4, 8, 2)],
    });
    expect(failures(results)).toEqual([]);
  });
});

describe('custom tile matrix sets (F228)', () => {
  it('chooses, for each image, the coarsest matrix at least as fine as its pixels, with non-power-of-two ratios', async () => {
    const { customCapabilities, MATRICES, tileBox } = await import('../__fixtures__/wmts-custom.js');
    const set = parseWmtsCapabilities(customCapabilities('https://wmts.test/')).tileMatrixSets[0];
    if (!set) throw new Error('no matrix set');
    expect(set.crs).toBe('EPSG:25832');
    const matrixOf = (metersPerPx: number): string | undefined => {
      // A 256-pixel image centred in the data at the given resolution.
      const half = (256 * metersPerPx) / 2;
      const parts = wmtsParts(
        set.matrices,
        new Map(),
        (matrix, row, col) => `${matrix}/${String(row)}/${String(col)}`,
        [550_000 - half, 4_800_000 - half, 550_000 + half, 4_800_000 + half],
        256,
        256,
      );
      return parts[0]?.url.split('/')[0];
    };
    // Pixel sizes of the matrices: 840, 336, 134.4, 44.8 and 17.92 m.
    const pixelM = MATRICES.map((m) => m.scaleDenominator * 0.00028);
    for (const [i, matrix] of MATRICES.entries()) {
      // Just coarser than the matrix's pixels: the matrix itself is the coarsest fine enough.
      expect(matrixOf((pixelM[i] ?? 0) * 1.01), `${matrix.id}`).toBe(matrix.id);
    }
    // Between two matrices the finer one is used, never a coarser one that would blur the view.
    expect(matrixOf(200)).toBe('L2');
    expect(matrixOf(50)).toBe('L3');
    // Finer than the finest: the finest.
    expect(matrixOf(5)).toBe('L4');
    // Tiles outside a partial matrix are not requested.
    expect(tileBox('L0', 3, 0)).toBeUndefined();
    expect(tileBox('L4', 0, 76)).toBeDefined();
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { TileCoord } from '@vibeglobe/core';
import { failures, runParserConformance, runTiledConformance } from '../conformance/index.js';
import { fetchTransport } from '../fetch-transport.js';
import { SourceConfigError } from '../metadata.js';
import { parseWmtsCapabilities } from './wmts-capabilities.js';
import { wmtsImagery } from './wmts-imagery.js';

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

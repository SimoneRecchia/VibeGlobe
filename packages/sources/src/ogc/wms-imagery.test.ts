import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { TileCoord, TransportResult } from '@vibeglobe/core';
import { failures, runParserConformance, runTiledConformance } from '../conformance/index.js';
import { fetchTransport } from '../fetch-transport.js';
import { SourceConfigError } from '../metadata.js';
import { parseWmsCapabilities } from './wms-capabilities.js';
import { wmsImagery } from './wms-imagery.js';

const fixture = (name: string): string =>
  readFileSync(new URL(`../__fixtures__/capabilities/${name}`, import.meta.url), 'utf8');
const JPL = fixture('wms-111-jpl.xml');
const AASG = fixture('wms-130-aasg.xml');
const SYNTHETIC = fixture('wms-synthetic-130.xml');
const coord = (level: number, x: number, y: number): TileCoord => ({ root: 0, level, x, y });
const blank = () => ({ url: '', hostIndex: 0 });
const never = fetchTransport(() => new Promise<Response>(() => undefined));
const identityCrop = (bytes: ArrayBuffer): Promise<ArrayBuffer> => Promise.resolve(bytes);

function query(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

async function urlOf(options: Parameters<typeof wmsImagery>[0], c: TileCoord): Promise<URLSearchParams> {
  const source = await wmsImagery({ transport: never, ...options });
  const request = source.request(c, blank());
  if (request === 'noData' || request === 'unknown') throw new Error('no data');
  return query(request.url);
}

describe('parseWmsCapabilities (F231)', () => {
  it('reads version, GetMap endpoint, formats and named layers with inherited systems and bounds', () => {
    const jpl = parseWmsCapabilities(JPL);
    expect(jpl.version).toBe('1.1.1');
    expect(jpl.getMapUrl).toBe('http://wms.jpl.nasa.gov/wms.cgi?');
    expect(jpl.formats).toContain('image/png');
    const mosaic = jpl.layers.find((l) => l.name === 'global_mosaic');
    expect(mosaic?.crs).toContain('EPSG:4326');
    expect(mosaic?.bounds).toEqual([-180, -60, 180, 84]);
    expect(mosaic?.styles).toContain('visual');
    const aasg = parseWmsCapabilities(AASG);
    expect(aasg.version).toBe('1.3.0');
    expect(aasg.layers.map((l) => l.name)).toContain('Wellheader');
    expect(aasg.layers[0]?.crs).toEqual(expect.arrayContaining(['CRS:84', 'EPSG:4326', 'EPSG:3857']));
    const synthetic = parseWmsCapabilities(SYNTHETIC);
    expect(synthetic.layers.map((l) => [l.name, l.crs, l.opaque])).toEqual([
      ['ortho', ['EPSG:32632', 'EPSG:3857', 'EPSG:4326'], true],
      ['labels', ['EPSG:32632', 'EPSG:3857'], false],
      ['cadastre', ['EPSG:32632'], false],
    ]);
    expect(synthetic.layers[0]?.attribution).toEqual({ text: '© Fixture Agency', url: 'https://agency.test/' });
  });
});

describe('wmsImagery (F231, F227)', () => {
  it('writes 1.3.0 requests: CRS, size with gutter, format, transparency and Web Mercator BBOX', async () => {
    const params = await urlOf(
      { id: 'w', capabilities: SYNTHETIC, layers: ['ortho', 'labels'], gutterPx: 0 },
      coord(1, 1, 0),
    );
    expect(Object.fromEntries(params)).toMatchObject({
      MAP: 'italy',
      SERVICE: 'WMS',
      REQUEST: 'GetMap',
      VERSION: '1.3.0',
      LAYERS: 'ortho,labels',
      STYLES: ',',
      FORMAT: 'image/png',
      TRANSPARENT: 'TRUE',
      CRS: 'EPSG:3857',
      WIDTH: '256',
      HEIGHT: '256',
    });
    expect(params.get('BBOX')?.split(',').map(Number)).toEqual([0, 0, 20037508.3428, 20037508.3428]);
    const gutter = await urlOf({ id: 'g', capabilities: SYNTHETIC, layers: ['ortho'], gutterPx: 32 }, coord(1, 1, 0));
    expect([gutter.get('WIDTH'), gutter.get('HEIGHT')]).toEqual(['320', '320']);
    const box = gutter.get('BBOX')?.split(',').map(Number) ?? [];
    expect(box[0]).toBeCloseTo(-20037508.3428 / 8, 2);
  });

  it('puts latitude first for EPSG:4326 in 1.3.0 only, and names SRS in 1.1.1', async () => {
    const v130 = await urlOf(
      { id: 'a', capabilities: AASG, layers: ['Wellheader'], preferredCrs: 'EPSG:4326', gutterPx: 0 },
      coord(1, 0, 0),
    );
    expect([v130.get('CRS'), v130.get('BBOX')]).toEqual(['EPSG:4326', '0,-180,90,-90']);
    const v111 = await urlOf(
      { id: 'j', capabilities: JPL, layers: ['global_mosaic'], styles: ['visual'], gutterPx: 0 },
      coord(1, 1, 0),
    );
    expect([v111.get('VERSION'), v111.get('SRS'), v111.get('BBOX'), v111.get('STYLES')]).toEqual([
      '1.1.1',
      'EPSG:4326',
      '-90,0,0,90',
      'visual',
    ]);
  });

  it('requests EPSG:3857 directly when offered next to UTM, honors the preference, and refuses UTM-only (F227)', async () => {
    expect((await urlOf({ id: 'm', capabilities: SYNTHETIC, layers: ['ortho'] }, coord(5, 17, 11))).get('CRS')).toBe(
      'EPSG:3857',
    );
    const geographic = await wmsImagery({
      id: 'p',
      capabilities: SYNTHETIC,
      layers: ['ortho'],
      preferredCrs: 'EPSG:4326',
      transport: never,
    });
    expect(geographic.tiling.crs).toBe('EPSG:4326');
    await expect(wmsImagery({ id: 'u', capabilities: SYNTHETIC, layers: ['cadastre'] })).rejects.toThrow(
      /reprojection/,
    );
    await expect(wmsImagery({ id: 'x', capabilities: SYNTHETIC, layers: ['nope'] })).rejects.toThrow(SourceConfigError);
  });

  it('crops the gutter and treats XML service exceptions as permanent failures', async () => {
    const answers = new Map<string, Response>();
    const transport = fetchTransport((input) =>
      Promise.resolve(answers.get(String(input)) ?? new Response(null, { status: 404 })),
    );
    const crops: number[][] = [];
    const source = await wmsImagery({
      id: 'c',
      capabilities: SYNTHETIC,
      layers: ['labels'],
      gutterPx: 16,
      transport,
      cropImage: (bytes, _type, gutter, size) => {
        crops.push([bytes.byteLength, gutter, size]);
        return Promise.resolve(new ArrayBuffer(7));
      },
    });
    const run = (c: TileCoord, answer: Response): Promise<TransportResult> => {
      const request = source.request(c, blank());
      if (request === 'noData' || request === 'unknown') throw new Error('no data');
      answers.set(request.url, answer);
      return new Promise((resolve) => source.transport.start(request, { firstByteMs: 1000, totalMs: 1000 }, resolve));
    };
    const image = await run(
      coord(6, 34, 23),
      new Response(new Uint8Array(100), { headers: { 'Content-Type': 'image/png' } }),
    );
    expect(image).toMatchObject({ kind: 'ok', contentType: 'image/png' });
    expect(crops).toEqual([[100, 16, 256]]);
    const exception =
      '<ServiceExceptionReport><ServiceException>Layer not defined</ServiceException></ServiceExceptionReport>';
    const failed = await run(
      coord(6, 34, 24),
      new Response(exception, { headers: { 'Content-Type': 'application/vnd.ogc.se_xml' } }),
    );
    expect(failed).toEqual({ kind: 'status', status: 400, retryAfterMs: undefined });
  });

  it('passes the tiled conformance suite', async () => {
    const bytes = new TextEncoder().encode('png');
    const service: typeof fetch = (input) => {
      const bbox = query(String(input)).get('BBOX') ?? '';
      // The fixture server has no data for the tile whose BBOX starts at 626172.1357 (level 6, column 33).
      if (bbox.startsWith('626172.1357')) return Promise.resolve(new Response(null, { status: 404 }));
      return Promise.resolve(new Response(bytes.slice(), { headers: { 'Content-Type': 'image/png' } }));
    };
    const results = await runTiledConformance({
      name: 'wms',
      create: (fetchImpl) =>
        wmsImagery({
          id: 'w',
          capabilities: SYNTHETIC,
          layers: ['ortho'],
          gutterPx: 0,
          cropImage: identityCrop,
          transport: fetchTransport(fetchImpl),
        }),
      fixture: service,
      tiles: [coord(6, 34, 23), coord(2, 2, 1)].map((c) => ({ coord: c, bytes })),
      missing: [coord(6, 33, 23)],
      outside: [coord(3, 1, 3)],
    });
    expect(failures(results)).toEqual([]);
  });

  it('never crashes on fuzzed capabilities documents', async () => {
    const results = await runParserConformance({
      name: 'wms capabilities',
      parse: async (xml: string) => {
        try {
          return await wmsImagery({ id: 'fuzz', capabilities: `${xml}`, layers: ['ortho'], transport: never });
        } catch (error) {
          if (error instanceof SourceConfigError) return error;
          throw error;
        }
      },
      fixtures: [SYNTHETIC, JPL, AASG].map((xml, i) => ({
        name: `document ${i}`,
        input: xml,
        expect: () => undefined,
      })),
    });
    expect(failures(results)).toEqual([]);
  });
});

describe('wmsImagery reference-system codes', () => {
  it('sends the Web Mercator code the server advertises, such as EPSG:900913 (PT-06)', async () => {
    const capabilities = `<WMT_MS_Capabilities version="1.1.1"><Capability>
      <Request><GetMap><Format>image/png</Format><DCPType><HTTP><Get>
        <OnlineResource xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="https://wms.example/?"/>
      </Get></HTTP></DCPType></GetMap></Request>
      <Layer><Title>Root</Title><SRS>EPSG:900913</SRS><Layer><Name>roads</Name><Title>Roads</Title></Layer></Layer>
    </Capability></WMT_MS_Capabilities>`;
    const params = await urlOf({ id: 'g', capabilities, layers: ['roads'] }, coord(1, 0, 0));
    expect(params.get('SRS')).toBe('EPSG:900913');
  });
});

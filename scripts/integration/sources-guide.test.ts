// F268: the sources guide (docs/guides/sources.md) has a section with an example for every topic, and every `ts`
// example runs: in Node, with the hosts it names answered by the adapters' recorded fixtures and `createGlobe`
// standing in for a globe (the engine itself is tested in the browser).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as core from '@vibeglobe/core';
import * as gis from '@vibeglobe/gis';
import * as sources from '@vibeglobe/sources';
import * as conformance from '@vibeglobe/sources/conformance';
import * as geotiff from '@vibeglobe/sources/geotiff';
import * as mbtiles from '@vibeglobe/sources/mbtiles';
import * as vector from '@vibeglobe/sources/vector';
import { PNG } from 'pngjs';
import ts from 'typescript';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { geoImageTiff } from '../../packages/sources/src/__fixtures__/georeferenced.ts';
import { writeMbtiles } from '../../packages/sources/src/__fixtures__/mbtiles-writer.ts';
import { writePmtiles } from '../../packages/sources/src/__fixtures__/pmtiles-writer.ts';
import { terrainTile } from '../fixtures/tiles/terrain.ts';

const GUIDE = readFileSync('docs/guides/sources.md', 'utf8');
const EXAMPLES = [...GUIDE.matchAll(/```ts\n([\s\S]*?)```/g)].map((match) => match[1] ?? '');
const CAPABILITIES = new URL('../../packages/sources/src/__fixtures__/capabilities/', import.meta.url);
// sql.js's WebAssembly file, where npm installs it (the guide's examples name the URL an application hosts it at).
const SQL_WASM = resolve('node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');

/** A 2 × 2 PNG, the answer of every imagery tile URL. */
const PNG_TILE = new Uint8Array(PNG.sync.write(Object.assign(new PNG({ width: 2, height: 2 }), {})));
const TERRARIUM = new Uint8Array(
  terrainTile({ pattern: 'terrain' as never, scheme: 'mercator', level: 3, x: 4, y: 2 }, 'terrarium'),
);
const MVT = new Uint8Array(
  readFileSync(new URL('../../packages/sources/src/__fixtures__/mvt/real-chicago-13-2098-3045.mvt', import.meta.url)),
);
/** A Terrarium tile at 120 m everywhere: (128 × 256 + 120) − 32768. */
const AT_120_M = (() => {
  const png = new PNG({ width: 4, height: 4 });
  for (let i = 0; i < png.data.length; i += 4) png.data.set([128, 120, 0, 255], i);
  return new Uint8Array(PNG.sync.write(png));
})();
/** A small GeoTIFF in EPSG:4326 over Rome. */
const SURVEY = geoImageTiff({ crs: 'EPSG:4326', box: [12.3, 41.7, 12.7, 42.0], widthPx: 16, heightPx: 16 });
const tile = (bytes: Uint8Array) => new Map([['3/4/2', bytes]]);

/** Range answers from an archive's bytes. */
function ranged(bytes: Uint8Array, init?: RequestInit): Response {
  const match = /bytes=(\d+)-(\d+)/.exec(new Headers(init?.headers).get('Range') ?? '');
  if (!match) return new Response(bytes.slice());
  return new Response(bytes.slice(Number(match[1]), Number(match[2]) + 1), { status: 206 });
}

async function guideFetch(): Promise<typeof fetch> {
  const archives: Record<string, Uint8Array> = {
    'https://cdn.example.com/italy.pmtiles': writePmtiles(tile(PNG_TILE)),
    'https://cdn.example.com/alps.pmtiles': writePmtiles(tile(TERRARIUM)),
    'https://cdn.example.com/roads.pmtiles': writePmtiles(tile(MVT), { tileType: 1 }),
    'http://nas.local/italy.mbtiles': await writeMbtiles(tile(PNG_TILE), { format: 'png' }),
    'http://nas.local/alps-dem.mbtiles': await writeMbtiles(tile(TERRARIUM), { format: 'png' }),
  };
  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const archive = archives[url];
    if (archive) return ranged(archive, init);
    if (url === 'https://images.example.com/survey.tif') return new Response(SURVEY.slice(0));
    if (url === 'https://wmts.example.com/WMTSCapabilities.xml')
      return new Response(readFileSync(new URL('wmts-synthetic.xml', CAPABILITIES), 'utf8'));
    if (url.startsWith('https://wms.example.com/?SERVICE=WMS&REQUEST=GetCapabilities'))
      return new Response(readFileSync(new URL('wms-synthetic-130.xml', CAPABILITIES), 'utf8'));
    if (url === 'https://dem.example.com/mesh/layer.json')
      return Response.json({
        tilejson: '2.1.0',
        format: 'quantized-mesh-1.0',
        version: '1.0.0',
        scheme: 'tms',
        tiles: ['{z}/{x}/{y}.terrain'],
        minzoom: 0,
        maxzoom: 12,
        available: [[{ startX: 0, startY: 0, endX: 1, endY: 0 }]],
      });
    return new Response(PNG_TILE.slice(), { headers: { 'Content-Type': 'image/png' } });
  };
}

/** The values the examples take from the application. */
function application(fetchImpl: typeof fetch) {
  const layers = { set: () => undefined, move: () => undefined, list: () => [] };
  return {
    container: {},
    renderer: {},
    baseImageryUrl: '/imagery/base.jpg',
    workers: {},
    myRestrictedKey: 'restricted-key',
    text: JSON.stringify({ type: 'Point', coordinates: [12.5, 41.9] }),
    kmzBytes: new TextEncoder().encode(
      '<kml xmlns="http://www.opengis.net/kml/2.2"><Placemark><Point><coordinates>12.5,41.9</coordinates></Point></Placemark></kml>',
    ),
    bytes: MVT,
    session: { token: 'token', renew: () => Promise.resolve() },
    // The recorded service has no tile 3/5/2, the guide's `missing` tile.
    myRecordedService: ((input, init) =>
      String(input).includes('/3/5/2')
        ? Promise.resolve(new Response(null, { status: 404 }))
        : String(input).startsWith('https://dem.example.com/')
          ? Promise.resolve(new Response(AT_120_M.slice()))
          : fetchImpl(input, init)) as typeof fetch,
    myTransport: (f: typeof fetch) => sources.fetchTransport(f),
    myAdapter: ({ fetch: f }: { fetch: typeof fetch }) =>
      sources.withProfile(
        sources.xyzImagery({
          id: 'mine',
          url: 'https://tiles.example.com/{z}/{x}/{y}.png',
          transport: sources.fetchTransport(f),
        }),
        sources.CUSTOM_PROFILE,
      ),
    myPngDecoder: (bytes: Uint8Array) => {
      const png = PNG.sync.read(Buffer.from(bytes));
      return { rgba: new Uint8Array(png.data), sizePx: png.width };
    },
    expect: (value: unknown) => ({
      toEqual: (wanted: unknown) => expect(value, JSON.stringify(value)).toEqual(wanted),
    }),
    __modules: {
      '@vibeglobe/core': {
        ...core,
        createGlobe: () => ({ imageryLayers: layers, setPolarCapColors: () => undefined }),
      },
      '@vibeglobe/gis': gis,
      '@vibeglobe/sources': sources,
      '@vibeglobe/sources/conformance': conformance,
      '@vibeglobe/sources/geotiff': geotiff,
      '@vibeglobe/sources/mbtiles': mbtiles,
      '@vibeglobe/sources/vector': vector,
    },
  };
}

/** The example as an async function body: types stripped, imports read from the module table. */
function runnable(code: string): string {
  const js = ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, verbatimModuleSyntax: false },
  }).outputText;
  return js
    .replace(/import \{([^}]+)\} from '(@vibeglobe\/[\w/-]+)';/g, (_, names: string, from: string) => {
      const values = names
        .split(',')
        .map((n) => n.trim())
        .filter((n) => n.length > 0 && !n.startsWith('type '));
      return `const { ${values.join(', ')} } = __modules['${from}'];`;
    })
    .replace(/import\s+(type\s+)?\{[^}]*\}\s+from\s+'[^']+';/g, '')
    .replace(/export \{\};?/g, '')
    .replace("'/assets/sql-wasm.wasm'", JSON.stringify(SQL_WASM));
}

const realFetch = globalThis.fetch;
let fetchImpl: typeof fetch;
beforeAll(async () => {
  fetchImpl = await guideFetch();
  globalThis.fetch = fetchImpl;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

it(
  'the sources guide has a section with an example for every topic, and every example runs (F268)',
  { timeout: 60_000 },
  async () => {
    for (const heading of [
      '## The adapter interface',
      '## Imagery adapters',
      '## Terrain adapters',
      '## Vector tiles in packages',
      '## Single georeferenced images',
      '## Reprojection',
      '## Polar caps',
      '## Layer composition and source chains',
      '## Vector formats',
      '## Provider profiles',
      "### Your own provider's profile",
      '### Commercial providers, from your own code',
      '### OpenStreetMap public servers',
      '### Self-hosted OpenStreetMap tiles',
      '## Keeping secrets out of URLs',
      '## Writing and testing a custom adapter',
    ])
      expect(GUIDE).toContain(heading);
    // Apple map data is not offered, and the guide says why.
    expect(GUIDE).toMatch(/Apple's map data may only be used through Apple's own MapKit/);
    expect(EXAMPLES.length).toBeGreaterThanOrEqual(12);
    const values = application(fetchImpl);
    const names = Object.keys(values);
    for (const [i, example] of EXAMPLES.entries()) {
      const run = new Function(...names, `return (async () => {\n${runnable(example)}\n})();`) as (
        ...args: unknown[]
      ) => Promise<void>;
      await expect(
        run(...names.map((n) => values[n as keyof typeof values])),
        `example ${String(i + 1)}`,
      ).resolves.toBeUndefined();
    }
  },
);

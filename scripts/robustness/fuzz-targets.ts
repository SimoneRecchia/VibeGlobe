// The targets of the aggregate fuzz suite (F513, ADR 0162): every decoder and parser the engine feeds untrusted bytes
// or text, with valid seed inputs to mutate, the iterations per target, and the errors each documents. Any other
// exception is a crash; a call slower than the target's limit is a hang. PNG, JPEG and WebP decode in the browser
// (`createImageBitmap`) and are fuzzed there through the worker program (`e2e/decoder-fuzz.spec.ts`, F114).
import { readdirSync, readFileSync } from 'node:fs';
import { createGlobe, GlobeError } from '@vibeglobe/core';
import { decodeHeightmap, decodeQuantizedMesh, Ktx2Error, readKtx2, readLayerJson } from '@vibeglobe/core/decoders';
import { parseCoordinateResult } from '@vibeglobe/gis';
import { VectorStyle } from '@vibeglobe/layers/vector-tiles';
import { PackageError, validateManifest } from '@vibeglobe/offline';
import { parseWorldFile, pmtilesArchive } from '@vibeglobe/sources';
import { parseSubtree, parseTileContent, parseTileset } from '@vibeglobe/sources/tiles3d';
import { decodeMvt, parseGeoJson, parseGpx, parseKml } from '@vibeglobe/sources/vector';
import { TaskError } from '@vibeglobe/worker';
import { createTranscodeKtx2 } from '@vibeglobe/worker/transcode-ktx2';
import { writePmtiles } from '../../packages/sources/src/__fixtures__/pmtiles-writer.ts';
import { renderTile } from '../fixtures/tiles/generate.ts';
import { encodeKtx2 } from '../fixtures/tiles/ktx2.ts';

/** Every kind of input F513 names: the suite fails if a kind has no target. */
export const REQUIRED_KINDS = [
  'imagery',
  'terrain',
  'vector tiles',
  '3d tiles',
  'packages',
  'styles',
  'geojson',
  'kml',
  'gpx',
  'configuration',
  'coordinate strings',
] as const;

type FuzzKind = (typeof REQUIRED_KINDS)[number];

/** One decoder or parser under fuzzing. */
export interface FuzzTarget {
  /** Unique, also the folder of its regression fixtures. */
  readonly name: string;
  readonly kind: FuzzKind;
  /** Valid inputs the mutations start from. */
  seeds(): Promise<Uint8Array[]>;
  /** Text inputs are also mutated as JSON values or characters, not only as bytes. */
  readonly text?: boolean;
  /** Runs the target on one input; resolves or throws. */
  run(input: Uint8Array): unknown;
  /** The errors the target documents for malformed input; anything else it throws is a crash. */
  allowed(error: unknown): boolean;
  /** Inputs per run (scaled by `VIBEGLOBE_FUZZ_RUNS` / 2000). */
  readonly iterations: number;
  /** Slower than this is a hang. */
  readonly timeLimitMs: number;
  /**
   * Open engine bugs this target finds (docs/internal/known-bugs.md): failures matching them are logged, not failed, in the
   * default run until the bug is fixed; `VIBEGLOBE_FUZZ_KNOWN_BUGS=1` fails on them too (docs/internal/test-changes.md).
   */
  readonly knownBugs?: readonly { readonly id: string; readonly pattern: RegExp }[];
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const repo = new URL('../../', import.meta.url);
const file = (path: string): Uint8Array => new Uint8Array(readFileSync(new URL(path, repo)));
const files = (dir: string, extension: string): Uint8Array[] =>
  readdirSync(new URL(dir, repo))
    .filter((name) => name.endsWith(extension))
    .map((name) => file(`${dir}${name}`));
const json = (value: unknown): Uint8Array => encoder.encode(JSON.stringify(value));
/** Parses an input as JSON; malformed JSON is the caller's `JSON.parse` error, which the targets never see. */
const parsed = (input: Uint8Array): unknown => {
  try {
    return JSON.parse(decoder.decode(input)) as unknown;
  } catch {
    return undefined;
  }
};
const never = (): boolean => false;

const transcode = createTranscodeKtx2(async () =>
  WebAssembly.compile(file('packages/worker/wasm/vibeglobe-basis.wasm') as Uint8Array<ArrayBuffer>),
);
const notCancelled = { isCancelled: () => false };

const TILE = { scheme: 'mercator', pattern: 'world', level: 3, x: 4, y: 2, sizePx: 64 } as const;

/** Thrown by the stub renderer: the options passed validation and the engine began to start. */
class Accepted extends Error {}
const MANIFEST = {
  id: 'rome',
  version: '1',
  name: 'Rome',
  area: { westDeg: 11, southDeg: 41, eastDeg: 13, northDeg: 43 },
  sources: [
    {
      sourceId: 'world',
      kind: 'imagery',
      file: 'rome.pmtiles',
      minLevel: 0,
      maxLevel: 8,
      license: 'CC-BY-4.0',
      attribution: { text: '© OpenStreetMap contributors' },
    },
  ],
  files: [{ path: 'rome.pmtiles', format: 'pmtiles', bytes: 1024, sha256: 'a'.repeat(64), chunkBytes: 512 }],
};
const TILING = {
  scheme: 'QUADTREE',
  subtreeLevels: 3,
  availableLevels: 6,
  subtrees: 'subtrees/{level}.{x}.{y}.subtree',
  contents: ['content/{level}/{x}/{y}.b3dm'],
} as const;

export const TARGETS: readonly FuzzTarget[] = [
  {
    name: 'ktx2-transcode',
    kind: 'imagery',
    seeds: async () => [
      new Uint8Array(await encodeKtx2(renderTile(TILE), TILE.sizePx, TILE.sizePx, 'etc1s')),
      new Uint8Array(await encodeKtx2(renderTile(TILE), TILE.sizePx, TILE.sizePx, 'uastc')),
    ],
    run: async (input) => {
      readKtx2(input);
      const copy = input.slice();
      return transcode({ bytes: copy.buffer, formats: ['rgba8'] } as never, notCancelled as never);
    },
    allowed: (error) => error instanceof Ktx2Error || error instanceof TaskError,
    iterations: 1000,
    timeLimitMs: 2000,
  },
  {
    name: 'world-file',
    kind: 'imagery',
    text: true,
    seeds: async () => [encoder.encode('0.01\n0\n0\n-0.01\n10.005\n45.995\n')],
    run: (input) => parseWorldFile(decoder.decode(input)),
    allowed: never,
    iterations: 2000,
    timeLimitMs: 200,
  },
  {
    name: 'heightmap',
    kind: 'terrain',
    seeds: async () => [renderTile({ ...TILE, sizePx: 16 })],
    // Any RGBA bytes are a valid heightmap: the sizes come from the tile, so they are fuzzed with the bytes.
    run: (input) => {
      const sizePx = Math.max(1, Math.floor(Math.sqrt(input.length / 4)));
      decodeHeightmap(input, sizePx, input.length % 2 === 0 ? 'terrarium' : 'terrain-rgb');
    },
    allowed: (error) => error instanceof RangeError && /heightmap/.test(error.message),
    iterations: 2000,
    timeLimitMs: 200,
  },
  {
    name: 'quantized-mesh',
    kind: 'terrain',
    seeds: async () => [file('packages/core/src/terrain/fixtures/geographic-8-266-62.terrain')],
    run: (input) => decodeQuantizedMesh(input),
    // Bounds-checked reads throw a RangeError naming the format (F131).
    allowed: (error) => error instanceof RangeError && error.message.startsWith('quantized-mesh:'),
    iterations: 2000,
    timeLimitMs: 500,
  },
  {
    name: 'layer-json',
    kind: 'terrain',
    text: true,
    seeds: async () => [
      json({
        tilejson: '2.1.0',
        format: 'quantized-mesh-1.0',
        tiles: ['{z}/{x}/{y}.terrain'],
        projection: 'EPSG:4326',
        extensions: ['octvertexnormals', 'metadata'],
        available: [[{ startX: 0, startY: 0, endX: 1, endY: 0 }], [{ startX: 0, startY: 0, endX: 3, endY: 1 }]],
        maxzoom: 1,
      }),
    ],
    run: (input) => readLayerJson(parsed(input)),
    // Invalid documents throw a TypeError naming the field (`layer-json.ts`).
    allowed: (error) => error instanceof TypeError && error.message.startsWith('layer.json:'),
    iterations: 2000,
    timeLimitMs: 200,
  },
  {
    name: 'mvt',
    kind: 'vector tiles',
    seeds: async () => files('packages/sources/src/__fixtures__/mvt/', '.mvt').slice(0, 20),
    run: (input) => decodeMvt(input),
    allowed: never,
    iterations: 2000,
    timeLimitMs: 500,
  },
  {
    name: 'tiles3d-content',
    kind: '3d tiles',
    seeds: async () => [
      file('packages/sources/src/__fixtures__/tiles3d/discrete-lod/dragon_low.b3dm'),
      file('apps/playground/public/tiles3d/city-draco/tiles/2/0/0.glb'),
    ],
    run: (input) => parseTileContent(input),
    allowed: never,
    iterations: 1000,
    timeLimitMs: 1000,
  },
  {
    name: 'tiles3d-tileset',
    kind: '3d tiles',
    text: true,
    seeds: async () => [file('packages/sources/src/__fixtures__/tiles3d/discrete-lod/tileset.json')],
    run: (input) => parseTileset(parsed(input), 'https://example.test/tileset.json'),
    allowed: never,
    iterations: 2000,
    timeLimitMs: 500,
  },
  {
    name: 'tiles3d-subtree',
    kind: '3d tiles',
    seeds: async () =>
      files('packages/sources/src/__fixtures__/tiles3d/sparse-implicit-quadtree/subtrees/', '.subtree'),
    run: (input) => parseSubtree(input, TILING as never),
    allowed: never,
    iterations: 2000,
    timeLimitMs: 500,
  },
  {
    name: 'package-manifest',
    kind: 'packages',
    text: true,
    seeds: async () => [json(MANIFEST)],
    run: (input) => validateManifest(parsed(input)),
    allowed: (error) => error instanceof PackageError,
    iterations: 2000,
    timeLimitMs: 200,
  },
  {
    name: 'pmtiles-archive',
    kind: 'packages',
    seeds: async () => [
      writePmtiles(new Map([['0/0/0', file('packages/sources/src/__fixtures__/mvt/001.mvt')]]), {
        tileType: 1,
        metadata: { name: 'fuzz' },
      }),
    ],
    // Opening reads and validates the header, the root directory and the metadata.
    run: (input) => pmtilesArchive({ id: 'fuzz', archive: new Blob([input.slice()]) }, 'any'),
    // Malformed archives are configuration errors of the source (`SourceConfigError`) or failed reads of it.
    allowed: (error) => error instanceof Error && /PMTiles|pmtiles|archive|Wrong magic|header/i.test(error.message),
    iterations: 1000,
    timeLimitMs: 1000,
  },
  {
    name: 'vector-style',
    kind: 'styles',
    text: true,
    seeds: async () => [
      file('apps/playground/public/vector-tiles/styles/demotiles.json'),
      file('apps/playground/public/vector-tiles/styles/streets.json'),
    ],
    // Problems are reported in `problems`; loading never throws (F451).
    run: (input) => VectorStyle.load(parsed(input)),
    allowed: never,
    iterations: 1000,
    timeLimitMs: 1000,
  },
  {
    name: 'geojson',
    kind: 'geojson',
    text: true,
    seeds: async () => [
      json({
        type: 'FeatureCollection',
        features: [
          { type: 'Feature', id: 1, properties: { name: 'a' }, geometry: { type: 'Point', coordinates: [12.5, 41.9] } },
          {
            type: 'Feature',
            properties: null,
            geometry: {
              type: 'Polygon',
              coordinates: [
                [
                  [0, 0],
                  [1, 0],
                  [1, 1],
                  [0, 0],
                ],
              ],
            },
          },
          {
            type: 'Feature',
            properties: {},
            geometry: {
              type: 'GeometryCollection',
              geometries: [
                {
                  type: 'MultiLineString',
                  coordinates: [
                    [
                      [0, 0],
                      [2, 2],
                    ],
                  ],
                },
              ],
            },
          },
        ],
      }),
    ],
    run: (input) => parseGeoJson(input),
    allowed: never,
    iterations: 2000,
    timeLimitMs: 500,
  },
  {
    name: 'kml',
    kind: 'kml',
    text: true,
    seeds: async () => files('packages/sources/src/__fixtures__/vector/', '.kml'),
    run: (input) => parseKml(input),
    allowed: never,
    iterations: 2000,
    timeLimitMs: 500,
  },
  {
    name: 'gpx',
    kind: 'gpx',
    text: true,
    seeds: async () => files('packages/sources/src/__fixtures__/vector/', '.gpx'),
    run: (input) => parseGpx(input),
    allowed: never,
    iterations: 2000,
    timeLimitMs: 500,
  },
  {
    name: 'globe-options',
    kind: 'configuration',
    text: true,
    seeds: async () => [
      json({
        view: { longitudeDeg: 12.5, latitudeDeg: 41.9, zoom: 4, headingDeg: 10, tiltDeg: 20 },
        home: { view: { zoom: 2 }, viewMode: 'auto' },
        imageryFadeMs: 250,
        terrainClearanceMeters: 2,
        constraints: { minZoom: 1, maxZoom: 20, maxTiltDeg: 60 },
        memory: { gpuBudgetBytes: 1e8, ramBudgetBytes: 1e8 },
        hiddenCredits: ['x'],
      }),
    ],
    // The options of a configuration file or a host's JSON, with the parts JSON cannot hold: a container and a
    // renderer factory that stops the start once the options passed validation.
    run: (input) => {
      const options = parsed(input);
      const complete =
        options && typeof options === 'object' && !Array.isArray(options)
          ? {
              container: {},
              baseImageryUrl: 'base.jpg',
              renderer: () => {
                throw new Accepted();
              },
              ...options,
            }
          : options;
      createGlobe(complete as never).destroy();
    },
    allowed: (error) => error instanceof GlobeError || error instanceof Accepted,
    iterations: 2000,
    timeLimitMs: 200,
  },
  {
    name: 'coordinates',
    kind: 'coordinate strings',
    text: true,
    seeds: async () =>
      ['41.9, 12.5', '41°54′N 12°30′E', '41 54 0.0 N, 12 30 0.0 E', '33T 291000 4641000', 'N 41.9 E 12.5'].map((s) =>
        encoder.encode(s),
      ),
    run: (input) => parseCoordinateResult(decoder.decode(input)),
    allowed: never,
    iterations: 4000,
    timeLimitMs: 100,
  },
];

// Fixture offline packages built in the harness page (browser code): tiles of a fixture pattern over an area and zoom
// range, written as PMTiles (the offline package's fixture writer) or MBTiles (sql.js), with their manifest.
import type { PackageManifest } from '@vibeglobe/offline';

/** What to build. */
export interface FixturePackageSpec {
  readonly id: string;
  readonly version: string;
  readonly sourceId: string;
  readonly pattern: string;
  readonly session: string;
  readonly bounds: { westDeg: number; southDeg: number; eastDeg: number; northDeg: number };
  readonly minLevel: number;
  readonly maxLevel: number;
  readonly format?: 'pmtiles' | 'mbtiles';
  readonly chunkBytes?: number;
  /** Tiles left out (`z/x/y`), for partial packages. */
  readonly skip?: readonly string[];
  /** Levels left out entirely. */
  readonly skipLevels?: readonly number[];
  readonly license?: string;
  readonly attribution?: string;
  /** File extension of the fixture tiles (default `png`; `terrarium.png` for terrain, F328). */
  readonly extension?: string;
}

/** A built fixture package: its manifest and file. */
export interface FixturePackage {
  readonly manifest: PackageManifest;
  readonly file: Uint8Array;
  readonly path: string;
}

interface Writers {
  writeMbtiles(
    tiles: { z: number; x: number; y: number; bytes: Uint8Array }[],
    metadata: Record<string, string>,
    wasmUrl?: string,
  ): Promise<Uint8Array>;
  writePmtiles(
    tiles: { z: number; x: number; y: number; bytes: Uint8Array }[],
    metadata: Record<string, unknown>,
  ): Uint8Array;
}

interface OfflineModule {
  createManifest(input: unknown): Promise<PackageManifest>;
}

const repo = location.pathname.replace(/\/e2e\/support\/[^/]*$/, '');

function tileRange(
  level: number,
  bounds: FixturePackageSpec['bounds'],
): { x0: number; x1: number; y0: number; y1: number } {
  const n = 2 ** level;
  const x = (lon: number): number => Math.min(n - 1, Math.floor(((lon + 180) / 360) * n));
  const y = (lat: number): number => {
    const r = (lat * Math.PI) / 180;
    return Math.min(n - 1, Math.max(0, Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n)));
  };
  return { x0: x(bounds.westDeg), x1: x(bounds.eastDeg), y0: y(bounds.northDeg), y1: y(bounds.southDeg) };
}

/** Fetches the fixture tiles of a package from the dev server. */
async function fixtureTiles(
  spec: FixturePackageSpec,
): Promise<{ z: number; x: number; y: number; bytes: Uint8Array }[]> {
  const tiles: { z: number; x: number; y: number; bytes: Uint8Array }[] = [];
  for (let z = spec.minLevel; z <= spec.maxLevel; z++) {
    if (spec.skipLevels?.includes(z)) continue;
    const r = tileRange(z, spec.bounds);
    for (let y = r.y0; y <= r.y1; y++)
      for (let x = r.x0; x <= r.x1; x++) {
        if (spec.skip?.includes(`${z}/${x}/${y}`)) continue;
        const response = await fetch(
          `/fixture-tiles/${spec.session}/${spec.pattern}/mercator/${z}/${x}/${y}.${spec.extension ?? 'png'}`,
        );
        tiles.push({ z, x, y, bytes: new Uint8Array(await response.arrayBuffer()) });
      }
  }
  return tiles;
}

/** Builds a fixture package in the page. */
export async function buildFixturePackage(spec: FixturePackageSpec): Promise<FixturePackage> {
  const repoFixtures = `${repo}/packages/offline/src/__fixtures__`;
  const pmtiles = (await import(/* @vite-ignore */ `${repoFixtures}/pmtiles-writer.ts`)) as Pick<
    Writers,
    'writePmtiles'
  >;
  const mbtiles = (await import(/* @vite-ignore */ `${repoFixtures}/mbtiles-writer.ts`)) as Pick<
    Writers,
    'writeMbtiles'
  >;
  const writers: Writers = { writePmtiles: pmtiles.writePmtiles, writeMbtiles: mbtiles.writeMbtiles };
  const offline = (await import(/* @vite-ignore */ `${repo}/packages/offline/src/index.ts`)) as OfflineModule;
  const tiles = await fixtureTiles(spec);
  const format = spec.format ?? 'pmtiles';
  const b = spec.bounds;
  const file =
    format === 'pmtiles'
      ? writers.writePmtiles(tiles, {
          name: spec.id,
          version: spec.version,
          bounds: [b.westDeg, b.southDeg, b.eastDeg, b.northDeg],
        })
      : await writers.writeMbtiles(
          tiles,
          {
            name: spec.id,
            format: 'png',
            minzoom: String(spec.minLevel),
            maxzoom: String(spec.maxLevel),
            bounds: `${b.westDeg},${b.southDeg},${b.eastDeg},${b.northDeg}`,
          },
          `${repo}/node_modules/sql.js/dist/sql-wasm.wasm`,
        );
  const path = `${spec.id}.${format}`;
  const manifest = await offline.createManifest({
    id: spec.id,
    version: spec.version,
    name: spec.id,
    area: spec.bounds,
    sources: [
      {
        sourceId: spec.sourceId,
        file: path,
        minLevel: spec.minLevel,
        maxLevel: spec.maxLevel,
        license: spec.license ?? 'CC-BY-4.0',
        attribution: { text: spec.attribution ?? `Fixture ${spec.pattern}` },
      },
    ],
    files: [{ path, format, data: new Blob([file as Uint8Array<ArrayBuffer>]) }],
    ...(spec.chunkBytes === undefined ? {} : { chunkBytes: spec.chunkBytes }),
  });
  return { manifest, file, path };
}

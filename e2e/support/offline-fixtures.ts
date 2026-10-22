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
  readonly license?: string;
  readonly attribution?: string;
}

/** A built fixture package: its manifest and file. */
export interface FixturePackage {
  readonly manifest: PackageManifest;
  readonly file: Uint8Array;
  readonly path: string;
}

interface Writers {
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

async function writeMbtiles(
  tiles: { z: number; x: number; y: number; bytes: Uint8Array }[],
  spec: FixturePackageSpec,
): Promise<Uint8Array> {
  const { default: initSqlJs } = (await import(/* @vite-ignore */ `${repo}/node_modules/sql.js/dist/sql-wasm.js`)) as {
    default: (o: {
      locateFile: () => string;
    }) => Promise<{ Database: new () => { run(sql: string, params?: unknown[]): void; export(): Uint8Array } }>;
  };
  const sql = await initSqlJs({ locateFile: () => `${repo}/node_modules/sql.js/dist/sql-wasm.wasm` });
  const db = new sql.Database();
  db.run('CREATE TABLE metadata (name text, value text)');
  db.run('CREATE TABLE tiles (zoom_level integer, tile_column integer, tile_row integer, tile_data blob)');
  const b = spec.bounds;
  for (const [name, value] of [
    ['name', spec.id],
    ['format', 'png'],
    ['minzoom', String(spec.minLevel)],
    ['maxzoom', String(spec.maxLevel)],
    ['bounds', `${b.westDeg},${b.southDeg},${b.eastDeg},${b.northDeg}`],
  ])
    db.run('INSERT INTO metadata VALUES (?, ?)', [name, value]);
  for (const t of tiles) db.run('INSERT INTO tiles VALUES (?, ?, ?, ?)', [t.z, t.x, 2 ** t.z - 1 - t.y, t.bytes]);
  return db.export();
}

/** Builds a fixture package in the page. */
export async function buildFixturePackage(spec: FixturePackageSpec): Promise<FixturePackage> {
  const writers = (await import(
    /* @vite-ignore */ `${repo}/packages/offline/src/__fixtures__/pmtiles-writer.ts`
  )) as Writers;
  const offline = (await import(/* @vite-ignore */ `${repo}/packages/offline/src/index.ts`)) as OfflineModule;
  const tiles: { z: number; x: number; y: number; bytes: Uint8Array }[] = [];
  for (let z = spec.minLevel; z <= spec.maxLevel; z++) {
    const r = tileRange(z, spec.bounds);
    for (let y = r.y0; y <= r.y1; y++)
      for (let x = r.x0; x <= r.x1; x++) {
        if (spec.skip?.includes(`${z}/${x}/${y}`)) continue;
        const response = await fetch(`/fixture-tiles/${spec.session}/${spec.pattern}/mercator/${z}/${x}/${y}.png`);
        tiles.push({ z, x, y, bytes: new Uint8Array(await response.arrayBuffer()) });
      }
  }
  const format = spec.format ?? 'pmtiles';
  const b = spec.bounds;
  const file =
    format === 'pmtiles'
      ? writers.writePmtiles(tiles, {
          name: spec.id,
          version: spec.version,
          bounds: [b.westDeg, b.southDeg, b.eastDeg, b.northDeg],
        })
      : await writeMbtiles(tiles, spec);
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

// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import {
  type TerrainSource,
  WEB_MERCATOR_TILING,
  type TileCoord,
  type TileRectangleRad,
  type TileRequest,
} from '@vibeglobe/core';
import type { Database } from 'sql.js';
import { archiveTransport, HttpStatusError, NetworkError, tileOfUrl } from './archive-transport.js';
import { retryAfterMs } from './fetch-transport.js';
import {
  type Attribution,
  CUSTOM_PROFILE,
  type DescribedImagerySource,
  type DescribedSource,
  type ProviderProfile,
  SourceConfigError,
} from './metadata.js';
import { coverageOf, inLevelsAndCoverage } from './tiling.js';
import {
  type ArchiveTerrainOptions,
  terrainFromArchive,
  vectorFromArchive,
  type VectorTileSource,
} from './archive-sources.js';

/** Options of {@link mbtilesImagery}. */
export interface MbtilesImageryOptions {
  /** Unique per engine instance. */
  readonly id: string;
  /** The package: a URL on a LAN or static server (downloaded once), or a local `File` or `Blob`. */
  readonly package: string | Blob;
  /**
   * URL of `sql-wasm.wasm` from the `sql.js` package, which the application hosts (ADR 0015); in Node the package
   * finds it itself.
   */
  readonly wasmUrl?: string;
  /** Replaces the attribution recorded in the package's metadata. */
  readonly attribution?: readonly Attribution[];
  readonly profile?: ProviderProfile;
  readonly headers?: Readonly<Record<string, string>>;
  readonly credentials?: RequestCredentials;
  /** The `fetch` used to download the package; the global one by default. */
  readonly fetch?: typeof fetch;
  /** Time limit of the download (default 120 s). */
  readonly downloadTimeoutMs?: number;
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  avif: 'image/avif',
};

/** Content types of the non-raster formats packages of terrain and vector tiles declare (F328). */
const OTHER_TYPES: Readonly<Record<string, string>> = {
  pbf: 'application/vnd.mapbox-vector-tile',
  mvt: 'application/vnd.mapbox-vector-tile',
};

async function packageBytes(options: MbtilesImageryOptions): Promise<Uint8Array> {
  const source = options.package;
  if (typeof source !== 'string') return new Uint8Array(await source.arrayBuffer());
  const fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.downloadTimeoutMs ?? 120_000);
  let response: Response;
  try {
    response = await fetchImpl(source, {
      ...(options.headers ? { headers: options.headers } : {}),
      credentials: options.credentials ?? 'omit',
      mode: 'cors',
      signal: controller.signal,
    });
  } catch (error) {
    throw controller.signal.aborted ? new Error('the download timed out') : new NetworkError(error);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok)
    throw new HttpStatusError(response.status, retryAfterMs(response.headers.get('Retry-After'), Date.now()));
  return new Uint8Array(await response.arrayBuffer());
}

async function openDatabase(bytes: Uint8Array, wasmUrl: string | undefined): Promise<Database> {
  const { default: initSqlJs } = await import('sql.js');
  const sql = await initSqlJs(wasmUrl === undefined ? {} : { locateFile: () => wasmUrl });
  return new sql.Database(bytes);
}

/** The SQL that reads one tile: the `tiles` table or view, else the deduplicated `map` and `images` tables. */
function tileQuery(db: Database): string {
  const names = new Set(
    (db.exec("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')")[0]?.values ?? []).map((r) =>
      String(r[0]),
    ),
  );
  if (names.has('tiles'))
    return 'SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?';
  if (names.has('map') && names.has('images'))
    return (
      'SELECT images.tile_data FROM map JOIN images ON images.tile_id = map.tile_id ' +
      'WHERE map.zoom_level = ? AND map.tile_column = ? AND map.tile_row = ?'
    );
  throw new Error('neither a tiles table or view nor map and images tables');
}

function readMetadata(db: Database): Map<string, string> {
  const rows = db.exec('SELECT name, value FROM metadata')[0]?.values ?? [];
  return new Map(rows.map((r) => [String(r[0]), String(r[1])]));
}

function levelRange(db: Database, query: string, metadata: Map<string, string>): [number, number] {
  const min = Number(metadata.get('minzoom'));
  const max = Number(metadata.get('maxzoom'));
  if (Number.isInteger(min) && Number.isInteger(max) && metadata.has('minzoom') && metadata.has('maxzoom'))
    return [min, max];
  const table = query.includes('FROM map') ? 'map' : 'tiles';
  const row = db.exec(`SELECT MIN(zoom_level), MAX(zoom_level) FROM ${table}`)[0]?.values[0] ?? [];
  return [Number(row[0] ?? 0), Number(row[1] ?? 0)];
}

function attributionOf(metadata: Map<string, string>): Attribution[] {
  const raw = metadata.get('attribution');
  if (!raw) return [];
  const link = /href="([^"]+)"/.exec(raw)?.[1];
  const text = raw.replace(/<[^>]*>/g, '').trim();
  return text.length === 0 ? [] : [link === undefined ? { text } : { text, url: link }];
}

/** Opens the package and reads what the source needs, or refuses it with a descriptive error. */
async function openPackage(options: MbtilesImageryOptions, content: 'raster' | 'any') {
  let bytes: Uint8Array;
  try {
    bytes = await packageBytes(options);
  } catch (error) {
    throw new SourceConfigError(
      'unreachable-package',
      `MBTiles source '${options.id}': cannot download the package (${String(error)})`,
    );
  }
  try {
    const db = await openDatabase(bytes, options.wasmUrl);
    const query = tileQuery(db);
    const metadata = readMetadata(db);
    const format = (metadata.get('format') ?? 'png').toLowerCase();
    const contentType =
      CONTENT_TYPES[format] ?? (content === 'any' ? (OTHER_TYPES[format] ?? 'application/octet-stream') : undefined);
    if (contentType === undefined) throw new Error(`format '${format}' is not a raster image format`);
    const [minLevel, maxLevel] = levelRange(db, query, metadata);
    if (minLevel > maxLevel) throw new Error('minimum zoom above maximum zoom');
    const [w, s, e, n] = (metadata.get('bounds') ?? '').split(',').map(Number);
    const coverage = coverageOf(w ?? NaN, s ?? NaN, e ?? NaN, n ?? NaN);
    return { db, query, contentType, minLevel, maxLevel, coverage, attribution: attributionOf(metadata) };
  } catch (error) {
    throw new SourceConfigError(
      'unreadable-package',
      `MBTiles source '${options.id}': not a readable MBTiles package (${String(error)})`,
    );
  }
}

/**
 * A raster imagery source from an MBTiles (SQLite) package (F233): a local `File` or `Blob`, or a URL on a LAN or
 * static server that is downloaded once. Rows are TMS-ordered as the specification requires; the plain `tiles` table
 * and the deduplicated `map` and `images` schema both work. Resolves once the metadata is read.
 */
export function mbtilesImagery(options: MbtilesImageryOptions): Promise<DescribedImagerySource> {
  return mbtilesArchive(options, 'raster');
}

/** {@link mbtilesImagery} for any content; terrain and vector packages reuse its addressing and transport (F328). */
export async function mbtilesArchive(
  options: MbtilesImageryOptions,
  content: 'raster' | 'any',
): Promise<DescribedImagerySource> {
  const opened = await openPackage(options, content);
  const statement = opened.db.prepare(opened.query);
  const base = typeof options.package === 'string' ? options.package : `blob-package://${options.id}`;
  const extent: TileRectangleRad = { westRad: 0, southRad: 0, eastRad: 0, northRad: 0 };
  const source: DescribedImagerySource = {
    id: options.id,
    tiling: WEB_MERCATOR_TILING,
    minLevel: opened.minLevel,
    maxLevel: opened.maxLevel,
    tileSizePx: 256,
    pixelRatio: 1,
    ...(opened.coverage ? { coverage: [opened.coverage] } : {}),
    decoder: 'image',
    attribution: options.attribution ?? opened.attribution,
    profile: options.profile ?? CUSTOM_PROFILE,
    transportRequired: true,
    transport: archiveTransport((url) => {
      const tile = tileOfUrl(url);
      if (!tile) return Promise.resolve(undefined);
      statement.bind([tile.z, tile.x, 2 ** tile.z - 1 - tile.y]);
      const found = statement.step() ? statement.get()[0] : undefined;
      statement.reset();
      if (!(found instanceof Uint8Array) || found.length === 0) return Promise.resolve(undefined);
      const bytes = found.slice().buffer;
      return Promise.resolve({ bytes, contentType: opened.contentType });
    }),
    request(coord: TileCoord, out: TileRequest): TileRequest | 'noData' {
      if (!inLevelsAndCoverage(source, coord, extent)) return 'noData';
      out.url = `${base}#${coord.level}/${coord.x}/${coord.y}`;
      out.hostIndex = 0;
      return out;
    },
  };
  return source;
}

/** Terrain tiles (Terrarium, Terrain-RGB or quantized-mesh) from an MBTiles package (F328). */
export async function mbtilesTerrain(
  options: MbtilesImageryOptions & ArchiveTerrainOptions,
): Promise<TerrainSource & DescribedSource> {
  return terrainFromArchive(await mbtilesArchive(options, 'any'), options);
}

/** Mapbox Vector Tiles from an MBTiles package (F328). */
export async function mbtilesVector(options: MbtilesImageryOptions): Promise<VectorTileSource> {
  return vectorFromArchive(await mbtilesArchive(options, 'any'));
}

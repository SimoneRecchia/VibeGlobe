/**
 * The offline package builder (F304, F305, F307): an area (bounding box or polygon), a zoom range and an XYZ source
 * whose license allows packaging, estimated before any tile is downloaded, then fetched resumably into a PMTiles or
 * MBTiles package.
 */
import { join } from 'node:path';
import { checkSource, describeViolations } from '../license/gate.js';
import { attributionFor, findProfile } from '../license/profiles.js';
import { writeMbtiles } from '../output/mbtiles.js';
import { COMPRESSION, TILE_TYPES, writePmtiles } from '../output/pmtiles.js';
import { StepLog } from '../pipeline/step-log.js';
import { type Area, areaTileCount, areaTiles } from '../tiles/area.js';
import type { TileCoord } from '../tiles/mercator.js';
import { PIPELINE_VERSION } from '../version.js';

/** A package request. */
export interface PackRequest {
  source: string;
  profile: string;
  area: Area;
  minZoom: number;
  maxZoom: number;
  format: 'pmtiles' | 'mbtiles';
  out: string;
  /** Folder for resumable downloads. */
  workFolder: string;
  fetch: typeof fetch;
  report: (line: string) => void;
}

/** The estimate of a package. */
export interface PackEstimate {
  zooms: { z: number; tiles: number; bytes: number }[];
  tiles: number;
  bytes: number;
  /** Tiles whose size was probed with HEAD requests (no tile body is downloaded). */
  probed: number;
}

/** The URL of a tile. */
function tileUrl(template: string, tile: TileCoord): string {
  return template.replace('{z}', String(tile.z)).replace('{x}', String(tile.x)).replace('{y}', String(tile.y));
}

/** Throws when the source's terms forbid packaging (before anything is downloaded). */
export function gatePack(request: Pick<PackRequest, 'source' | 'profile'>): void {
  const violation = checkSource('package', request.profile, { type: 'xyz', url: request.source });
  if (violation) throw new Error(describeViolations([violation]));
}

/** Up to `count` tiles of a zoom level spread evenly over the area's tiles. */
function spread(area: Area, z: number, count: number): TileCoord[] {
  const total = areaTileCount(area, z);
  const step = Math.max(1, Math.floor(total / count));
  const picked: TileCoord[] = [];
  let index = 0;
  for (const tile of areaTiles(area, z)) {
    if (index++ % step === 0 && picked.length < count) picked.push(tile);
  }
  return picked;
}

async function probe(request: PackRequest, tile: TileCoord): Promise<number | undefined> {
  const response = await request.fetch(tileUrl(request.source, tile), { method: 'HEAD' });
  const length = Number(response.headers.get('content-length'));
  return response.ok && Number.isFinite(length) && length > 0 ? length : undefined;
}

/**
 * Estimates a package: exact tile counts per zoom (each extra level roughly quadruples them) and bytes from the
 * sizes of a few tiles per zoom read with HEAD requests; zooms without a probe use the nearest probed zoom.
 */
export async function estimatePack(request: PackRequest, probesPerZoom = 4): Promise<PackEstimate> {
  const zooms: PackEstimate['zooms'] = [];
  const means = new Map<number, number>();
  let probed = 0;
  for (let z = request.minZoom; z <= request.maxZoom; z++) {
    const sizes = (await Promise.all(spread(request.area, z, probesPerZoom).map((t) => probe(request, t)))).filter(
      (size): size is number => size !== undefined,
    );
    probed += sizes.length;
    if (sizes.length > 0) means.set(z, sizes.reduce((a, b) => a + b, 0) / sizes.length);
    zooms.push({ z, tiles: areaTileCount(request.area, z), bytes: 0 });
  }
  const known = [...means.keys()];
  for (const zoom of zooms) {
    const nearest = known.reduce(
      (best, z) => (Math.abs(z - zoom.z) < Math.abs(best - zoom.z) ? z : best),
      known[0] ?? 0,
    );
    zoom.bytes = Math.round(zoom.tiles * (means.get(nearest) ?? 20_000));
  }
  return {
    zooms,
    tiles: zooms.reduce((sum, z) => sum + z.tiles, 0),
    bytes: zooms.reduce((sum, z) => sum + z.bytes, 0),
    probed,
  };
}

const STEP = 'tile';

/** Downloads every tile of the request into the work folder, skipping verified ones; returns fetched/skipped/missing. */
export async function fetchPackTiles(request: PackRequest, concurrency = 8): Promise<Map<string, string>> {
  const log = new StepLog(join(request.workFolder, 'tiles.log'));
  const files = new Map<string, string>();
  const queue: TileCoord[] = [];
  for (let z = request.minZoom; z <= request.maxZoom; z++)
    for (const tile of areaTiles(request.area, z)) queue.push(tile);
  let fetched = 0;
  let skipped = 0;
  let missing = 0;
  const worker = async (): Promise<void> => {
    for (let tile = queue.shift(); tile; tile = queue.shift()) {
      const key = `${tile.z}/${tile.x}/${tile.y}`;
      const file = join(request.workFolder, 'tiles', key);
      if (log.logged(STEP, key) === 'missing') {
        missing++;
        continue;
      }
      if (log.check(STEP, key, file) === 'done') {
        files.set(key, file);
        skipped++;
        continue;
      }
      const response = await request.fetch(tileUrl(request.source, tile));
      if (response.status === 404 || response.status === 204) {
        log.record(STEP, key, 'missing');
        missing++;
        continue;
      }
      if (!response.ok) throw new Error(`${tileUrl(request.source, tile)}: HTTP ${response.status}`);
      log.write(STEP, key, file, new Uint8Array(await response.arrayBuffer()));
      files.set(key, file);
      fetched++;
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  request.report(`tiles: ${fetched} downloaded, ${skipped} already present (verified), ${missing} not served`);
  return files;
}

/** The tile type of the first tile's bytes. */
function sniff(bytes: Uint8Array): 'png' | 'jpeg' | 'webp' | 'mvt' {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpeg';
  if (bytes[0] === 0x52 && bytes[8] === 0x57) return 'webp';
  return 'mvt';
}

/** Writes the package from downloaded tiles, with the source's license and attribution in its metadata. */
export function writePack(
  request: PackRequest,
  files: Map<string, string>,
  read: (path: string) => Uint8Array,
): number {
  const profile = findProfile(request.profile);
  if (!profile) throw new Error(`unknown provider profile ${request.profile}`);
  const tiles = [...files.entries()].map(([key, path]) => {
    const [z, x, y] = key.split('/').map(Number) as [number, number, number];
    return { z, x, y, read: () => read(path) };
  });
  const first = tiles[0];
  const type = first ? sniff(first.read()) : 'png';
  const { west, south, east, north } = request.area.bbox;
  const metadata = {
    name: `package-${request.minZoom}-${request.maxZoom}`,
    format: type === 'jpeg' ? 'jpg' : type === 'mvt' ? 'pbf' : type,
    minzoom: request.minZoom,
    maxzoom: request.maxZoom,
    bounds: [west, south, east, north],
    attribution: attributionFor(profile, undefined),
    license: profile.license,
    licenseUrl: profile.licenseUrl,
    sources: [{ name: profile.name, url: request.source, license: profile.license }],
    area: request.area.kind === 'polygon' ? { polygon: request.area.rings } : { bbox: [west, south, east, north] },
    pipelineVersion: PIPELINE_VERSION,
  };
  if (request.format === 'mbtiles') {
    const rows = Object.fromEntries(
      Object.entries(metadata).map(([k, v]) => [
        k,
        typeof v === 'string' ? v : k === 'bounds' ? (v as number[]).join(',') : JSON.stringify(v),
      ]),
    );
    writeMbtiles(request.out, tiles, rows);
  } else {
    writePmtiles(
      request.out,
      tiles,
      {
        tileType: TILE_TYPES[type],
        tileCompression: type === 'mvt' && first && first.read()[0] === 0x1f ? COMPRESSION.gzip : COMPRESSION.none,
        minZoom: request.minZoom,
        maxZoom: request.maxZoom,
        bounds: request.area.bbox,
        center: { lon: (west + east) / 2, lat: (south + north) / 2, zoom: request.minZoom },
      },
      metadata,
    );
  }
  request.report(`wrote ${request.out} (${tiles.length} tiles)`);
  return tiles.length;
}

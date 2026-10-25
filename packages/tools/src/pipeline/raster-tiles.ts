// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * Raster tiling (ADR 0024): the maximum zoom of a dataset is sampled from the sources, every lower zoom is the 2×2
 * mean of its children, and each level is written as raw intermediate tiles and as encoded tiles.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';
import type { Mosaic } from '../raster/mosaic.js';
import { type Area, areaTiles } from '../tiles/area.js';
import { type TileCoord, tileXToLon, tileYToLat } from '../tiles/mercator.js';
import type { StepLog } from './step-log.js';

/** Tile size in pixels of every raster output. */
export const TILE_PX = 256;

/** Encodes raw samples (`sizePx²` × channels, row-major) into a tile file. */
export type TileEncoder = (samples: Float32Array, sizePx: number) => Uint8Array;

/** Everything raster tiling needs. */
export interface RasterTilingJob {
  area: Area;
  minZoom: number;
  maxZoom: number;
  mosaic: Mosaic;
  /** Work folder for raw tiles. */
  rawFolder: string;
  /** Folder of encoded tiles, `z/x/y.<extension>`. */
  tileFolder: string;
  extension: string;
  encode: TileEncoder;
  /**
   * Pixels of the neighbors' samples written around each tile (terrain: 1, so a tile is `TILE_PX + 2` wide and two
   * neighbors interpolate their shared edge from the same pixels, KB-178); 0 or absent for none.
   */
  borderPx?: number;
  log: StepLog;
  report: (line: string) => void;
}

const RAW = 'raw';
const TILE = 'tile';
/** Log name of bordered tiles: tiles written before borders existed are not taken as done. */
const BORDERED_TILE = 'tile-bordered';

/** Samples one tile from the mosaic, with box supersampling when a tile pixel spans several source pixels. */
function renderTile(tile: TileCoord, mosaic: Mosaic): Float32Array {
  const channels = mosaic.channels;
  const out = new Float32Array(TILE_PX * TILE_PX * channels);
  const scale = TILE_PX * 2 ** tile.z;
  const centerLon = tileXToLon(tile.x + 0.5, tile.z);
  const centerLat = tileYToLat(tile.y + 0.5, tile.z);
  const source = mosaic.pixelSizeAt(centerLon, centerLat) ?? 360 / scale;
  const steps = Math.max(1, Math.min(4, Math.round(360 / scale / source)));
  const sample = new Float64Array(channels);
  const sum = new Float64Array(channels);
  for (let py = 0; py < TILE_PX; py++) {
    for (let px = 0; px < TILE_PX; px++) {
      sum.fill(0);
      for (let sy = 0; sy < steps; sy++) {
        const lat = tileYToLat(tile.y + (py + (sy + 0.5) / steps) / TILE_PX, tile.z);
        for (let sx = 0; sx < steps; sx++) {
          mosaic.sample(tileXToLon(tile.x + (px + (sx + 0.5) / steps) / TILE_PX, tile.z), lat, sample);
          for (let c = 0; c < channels; c++) sum[c] = (sum[c] ?? 0) + (sample[c] ?? 0);
        }
      }
      const at = (py * TILE_PX + px) * channels;
      for (let c = 0; c < channels; c++) out[at + c] = (sum[c] ?? 0) / (steps * steps);
    }
  }
  return out;
}

/** The 2×2 mean of four child tiles (order: top-left, top-right, bottom-left, bottom-right). */
function downsample(children: Float32Array[], channels: number): Float32Array {
  const out = new Float32Array(TILE_PX * TILE_PX * channels);
  const half = TILE_PX / 2;
  children.forEach((child, quadrant) => {
    const ox = (quadrant % 2) * half;
    const oy = Math.floor(quadrant / 2) * half;
    for (let y = 0; y < half; y++) {
      for (let x = 0; x < half; x++) {
        const a = (2 * y * TILE_PX + 2 * x) * channels;
        const b = a + TILE_PX * channels;
        const at = ((oy + y) * TILE_PX + ox + x) * channels;
        for (let c = 0; c < channels; c++) {
          const sum = (child[a + c] ?? 0) + (child[a + channels + c] ?? 0) + (child[b + c] ?? 0);
          out[at + c] = (sum + (child[b + channels + c] ?? 0)) / 4;
        }
      }
    }
  });
  return out;
}

function tileKey(tile: TileCoord): string {
  return `${tile.z}/${tile.x}/${tile.y}`;
}

function rawPath(job: RasterTilingJob, tile: TileCoord): string {
  return join(job.rawFolder, `${tileKey(tile)}.f32.z`);
}

function readRaw(job: RasterTilingJob, tile: TileCoord): Float32Array | undefined {
  const path = rawPath(job, tile);
  if (job.log.check(RAW, tileKey(tile), path) !== 'done' || !existsSync(path)) return undefined;
  const bytes = inflateSync(readFileSync(path));
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

/** The raw samples of a tile: from the sources at the maximum zoom, else from its four children. */
function produce(job: RasterTilingJob, tile: TileCoord): Float32Array {
  if (tile.z === job.maxZoom) return renderTile(tile, job.mosaic);
  const children: Float32Array[] = [];
  for (let quadrant = 0; quadrant < 4; quadrant++) {
    const child = { z: tile.z + 1, x: tile.x * 2 + (quadrant % 2), y: tile.y * 2 + Math.floor(quadrant / 2) };
    // A child outside the area was not built: sample it from the sources so the parent has no hole.
    children.push(readRaw(job, child) ?? renderTile(child, job.mosaic));
  }
  return downsample(children, job.mosaic.channels);
}

/** The raw samples of a tile, built and logged unless verified already; whether they changed. */
function ensureRaw(job: RasterTilingJob, tile: TileCoord): { samples: Float32Array | undefined; built: boolean } {
  const key = tileKey(tile);
  const raw = rawPath(job, tile);
  const rawState = job.log.check(RAW, key, raw);
  if (rawState === 'done') return { samples: undefined, built: false };
  if (rawState === 'corrupt') job.report(`corrupt intermediate tile ${key}: regenerating`);
  const samples = produce(job, tile);
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  const before = job.log.logged(RAW, key);
  // A tile regenerated with the samples it had (a corrupted file) changes nothing its neighbors' borders read.
  return { samples, built: job.log.write(RAW, key, raw, deflateSync(bytes, { level: 1 })) !== before };
}

/**
 * The samples of `tile` with a ring of `border` pixels from its neighbors' own samples (from their raw tiles, or
 * produced for neighbors outside the area, kept in `outside` for the level); columns wrap at the antimeridian and rows
 * repeat at the tiling's north and south edges.
 */
function bordered(
  job: RasterTilingJob,
  tile: TileCoord,
  samples: Float32Array,
  border: number,
  outside: Map<string, Float32Array>,
): Float32Array {
  const channels = job.mosaic.channels;
  const size = TILE_PX + 2 * border;
  const out = new Float32Array(size * size * channels);
  const n = 2 ** tile.z;
  const neighbor = (dx: number, dy: number): Float32Array => {
    if (dx === 0 && dy === 0) return samples;
    const at = { z: tile.z, x: (tile.x + dx + n) % n, y: Math.min(n - 1, Math.max(0, tile.y + dy)) };
    const key = tileKey(at);
    const cached = outside.get(key);
    if (cached) return cached;
    const found = readRaw(job, at) ?? produce(job, at);
    outside.set(key, found);
    return found;
  };
  for (let y = 0; y < size; y++) {
    const sy = y - border;
    const dy = sy < 0 ? -1 : sy >= TILE_PX ? 1 : 0;
    // Beyond the tiling's north or south edge the neighbor is the tile itself: its outer row repeats.
    const clampRow = (tile.y === 0 && dy < 0) || (tile.y === n - 1 && dy > 0);
    const row = clampRow ? (dy < 0 ? 0 : TILE_PX - 1) : sy - dy * TILE_PX;
    for (let x = 0; x < size; x++) {
      const sx = x - border;
      const dx = sx < 0 ? -1 : sx >= TILE_PX ? 1 : 0;
      const from = neighbor(dx, clampRow ? 0 : dy);
      const source = (row * TILE_PX + sx - dx * TILE_PX) * channels;
      const target = (y * size + x) * channels;
      for (let c = 0; c < channels; c++) out[target + c] = from[source + c] ?? 0;
    }
  }
  if (outside.size > 64) outside.clear();
  return out;
}

/** Encodes one tile unless verified and its raw samples unchanged; whether it was (re)built. */
function encodeTile(
  job: RasterTilingJob,
  tile: TileCoord,
  rawBuilt: { samples: Float32Array | undefined; built: boolean },
  outside: Map<string, Float32Array>,
): boolean {
  const border = job.borderPx ?? 0;
  const name = border > 0 ? BORDERED_TILE : TILE;
  const key = tileKey(tile);
  const encoded = join(job.tileFolder, `${key}.${job.extension}`);
  const tileState = job.log.check(name, key, encoded);
  if (tileState === 'done' && !rawBuilt.built) return false;
  if (tileState === 'corrupt') job.report(`corrupt tile ${key}: regenerating`);
  const samples = rawBuilt.samples ?? readRaw(job, tile) ?? produce(job, tile);
  const out = border > 0 ? bordered(job, tile, samples, border, outside) : samples;
  job.log.write(name, key, encoded, job.encode(out, TILE_PX + 2 * border));
  return true;
}

/** Builds every tile of the job from the maximum zoom up; returns built and skipped counts. */
export function buildRasterTiles(job: RasterTilingJob): { built: number; skipped: number } {
  let built = 0;
  let skipped = 0;
  const border = job.borderPx ?? 0;
  for (let z = job.maxZoom; z >= job.minZoom; z--) {
    let levelBuilt = 0;
    let levelSkipped = 0;
    const outside = new Map<string, Float32Array>();
    const count = (wasBuilt: boolean): void => {
      if (wasBuilt) levelBuilt++;
      else levelSkipped++;
    };
    if (border === 0) {
      for (const tile of areaTiles(job.area, z)) {
        const raw = ensureRaw(job, tile);
        count(encodeTile(job, tile, raw, outside) || raw.samples !== undefined);
      }
    } else {
      // Every raw tile of the level first: the borders read the neighbors'. A tile is rebuilt when its own raw
      // samples or a neighbor's changed.
      const tiles = [...areaTiles(job.area, z)];
      const rebuilt = new Set<string>();
      const regenerated = new Set<string>();
      for (const tile of tiles) {
        const raw = ensureRaw(job, tile);
        if (raw.built) rebuilt.add(tileKey(tile));
        else if (raw.samples) regenerated.add(tileKey(tile));
      }
      for (const tile of tiles) {
        let changed = false;
        for (let dy = -1; dy <= 1 && !changed; dy++)
          for (let dx = -1; dx <= 1 && !changed; dx++)
            changed = rebuilt.has(tileKey({ z, x: tile.x + dx, y: tile.y + dy }));
        count(encodeTile(job, tile, { samples: undefined, built: changed }, outside) || regenerated.has(tileKey(tile)));
      }
    }
    job.report(`z${z}: ${levelBuilt} tiles built, ${levelSkipped} skipped (verified)`);
    built += levelBuilt;
    skipped += levelSkipped;
  }
  return { built, skipped };
}

/**
 * Raster tiling (ADR 0023): the maximum zoom of a dataset is sampled from the sources, every lower zoom is the 2×2
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

/** Encodes raw samples (`TILE_PX²` × channels, row-major) into a tile file. */
export type TileEncoder = (samples: Float32Array) => Uint8Array;

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
  log: StepLog;
  report: (line: string) => void;
}

const RAW = 'raw';
const TILE = 'tile';

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

/** Builds one tile unless both its raw and encoded files are verified; returns whether it was (re)built. */
function buildTile(job: RasterTilingJob, tile: TileCoord): boolean {
  const key = tileKey(tile);
  const raw = rawPath(job, tile);
  const encoded = join(job.tileFolder, `${key}.${job.extension}`);
  const rawState = job.log.check(RAW, key, raw);
  const tileState = job.log.check(TILE, key, encoded);
  if (rawState === 'done' && tileState === 'done') return false;
  if (rawState === 'corrupt') job.report(`corrupt intermediate tile ${key}: regenerating`);
  if (tileState === 'corrupt') job.report(`corrupt tile ${key}: regenerating`);
  const samples = rawState === 'done' ? (readRaw(job, tile) ?? produce(job, tile)) : produce(job, tile);
  if (rawState !== 'done') {
    const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
    job.log.write(RAW, key, raw, deflateSync(bytes, { level: 1 }));
  }
  job.log.write(TILE, key, encoded, job.encode(samples));
  return true;
}

/** Builds every tile of the job from the maximum zoom up; returns built and skipped counts. */
export function buildRasterTiles(job: RasterTilingJob): { built: number; skipped: number } {
  let built = 0;
  let skipped = 0;
  for (let z = job.maxZoom; z >= job.minZoom; z--) {
    let levelBuilt = 0;
    let levelSkipped = 0;
    for (const tile of areaTiles(job.area, z)) {
      if (buildTile(job, tile)) levelBuilt++;
      else levelSkipped++;
    }
    job.report(`z${z}: ${levelBuilt} tiles built, ${levelSkipped} skipped (verified)`);
    built += levelBuilt;
    skipped += levelSkipped;
  }
  return { built, skipped };
}

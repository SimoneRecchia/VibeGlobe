// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * Independent check of terrain tiles (F339): heights decoded from the output at random points are compared with the
 * same interpolation computed from source pixels that GDAL reads, in its pinned Docker image, from the downloaded DEM
 * files. The pipeline's own reader is not involved, so the check covers it too.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { DatasetConfig } from '../config/schema.js';
import { decodePng } from '../encode/png.js';
import { TERRARIUM_STEP_M, terrariumHeight } from '../encode/terrarium.js';
import { runTool } from '../runner/docker.js';
import type { SourceFile } from '../sources/files.js';
import { type Area, areaTiles } from '../tiles/area.js';
import { type TileCoord, tileXToLon, tileYToLat } from '../tiles/mercator.js';
import { TILE_PX } from './raster-tiles.js';

/** Result of a terrain verification. */
export interface TerrainCheck {
  points: number;
  maxErrorM: number;
  meanErrorM: number;
  toleranceM: number;
  passed: boolean;
}

/** Tolerance: half a Terrarium step plus float32 rounding of heights up to 9 km. */
const TERRAIN_TOLERANCE_M = TERRARIUM_STEP_M / 2 + 1e-3;

/** A small deterministic generator (mulberry32). */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Grid {
  path: string;
  originLon: number;
  originLat: number;
  stepLon: number;
  stepLat: number;
  width: number;
  height: number;
}

/** The geotransform GDAL reports for a file (GDAL applies pixel-is-point itself). */
function gdalGrid(image: string, folder: string, path: string): Grid {
  const info = JSON.parse(runTool({ image, folder, command: ['gdalinfo', '-json', relative(folder, path)] })) as {
    geoTransform: number[];
    size: [number, number];
  };
  const [originLon = 0, stepLon = 0, , originLat = 0, , stepLat = 0] = info.geoTransform;
  return { path, originLon, originLat, stepLon, stepLat: -stepLat, width: info.size[0], height: info.size[1] };
}

interface Point {
  tile: TileCoord;
  px: number;
  py: number;
  lon: number;
  lat: number;
}

/** Decoded height of one output pixel. */
function outputHeight(tiles: string, point: Point): number {
  const png = decodePng(
    new Uint8Array(readFileSync(join(tiles, `${point.tile.z}/${point.tile.x}/${point.tile.y}.png`))),
  );
  // Terrain tiles carry a one-pixel border of their neighbors' heights (KB-178).
  const border = (png.width - TILE_PX) / 2;
  const p = png.pixels.subarray(((point.py + border) * png.width + point.px + border) * 3);
  return terrariumHeight(p[0] ?? 0, p[1] ?? 0, p[2] ?? 0);
}

/** Random output pixels at the maximum zoom, at least two source pixels away from every file edge. */
function pickPoints(
  dataset: DatasetConfig,
  area: Area,
  grids: Grid[],
  count: number,
  seed: number,
): (Point & { grid: Grid })[] {
  const tiles = [...areaTiles(area, dataset.maxZoom)];
  const next = random(seed);
  const points: (Point & { grid: Grid })[] = [];
  for (let attempt = 0; points.length < count && attempt < count * 50; attempt++) {
    const tile = tiles[Math.floor(next() * tiles.length)] as TileCoord;
    const px = Math.floor(next() * TILE_PX);
    const py = Math.floor(next() * TILE_PX);
    const lon = tileXToLon(tile.x + (px + 0.5) / TILE_PX, tile.z);
    const lat = tileYToLat(tile.y + (py + 0.5) / TILE_PX, tile.z);
    const grid = grids.find((g) => {
      const fx = (lon - g.originLon) / g.stepLon;
      const fy = (g.originLat - lat) / g.stepLat;
      return fx >= 2 && fy >= 2 && fx <= g.width - 2 && fy <= g.height - 2;
    });
    if (grid) points.push({ tile, px, py, lon, lat, grid });
  }
  return points;
}

/** Bilinear interpolation of each point from its four source pixels, read by GDAL. */
function gdalBilinear(image: string, folder: string, grid: Grid, points: Point[]): number[] {
  const corners = points.map((p) => {
    const fx = (p.lon - grid.originLon) / grid.stepLon - 0.5;
    const fy = (grid.originLat - p.lat) / grid.stepLat - 0.5;
    return { x0: Math.floor(fx), y0: Math.floor(fy), tx: fx - Math.floor(fx), ty: fy - Math.floor(fy) };
  });
  const input = corners
    .flatMap((c) => [`${c.x0} ${c.y0}`, `${c.x0 + 1} ${c.y0}`, `${c.x0} ${c.y0 + 1}`, `${c.x0 + 1} ${c.y0 + 1}`])
    .join('\n');
  const command = ['gdallocationinfo', '-valonly', relative(folder, grid.path)];
  const values = runTool({ image, folder, command }, `${input}\n`).trim().split('\n').map(Number);
  return corners.map((c, i) => {
    const [v00 = 0, v10 = 0, v01 = 0, v11 = 0] = values.slice(i * 4, i * 4 + 4);
    return (v00 * (1 - c.tx) + v10 * c.tx) * (1 - c.ty) + (v01 * (1 - c.tx) + v11 * c.tx) * c.ty;
  });
}

/** Verifies terrain output against the source DEM files with GDAL; `files` are the build's source files. */
export function verifyTerrain(options: {
  dataset: DatasetConfig;
  area: Area;
  files: SourceFile[];
  root: string;
  image: string;
  points: number;
  seed: number;
}): TerrainCheck {
  const downloads = join(options.root, 'downloads', options.dataset.id);
  const paths = options.files.map((f) => join(downloads, f.key)).filter((p) => existsSync(p));
  if (paths.length === 0) throw new Error(`${options.dataset.id}: no downloaded source in ${downloads}; build first`);
  const grids = paths.map((path) => gdalGrid(options.image, options.root, path));
  // The comparison reproduces point sampling, which the tiler uses when an output pixel is no larger than ~1.5 source pixels.
  const pixelDeg = 360 / 2 ** options.dataset.maxZoom / TILE_PX;
  if (grids.some((g) => Math.round(pixelDeg / g.stepLon) > 1))
    throw new Error(
      `${options.dataset.id}: the maximum zoom is coarser than the source; verify compares point samples only`,
    );
  const points = pickPoints(options.dataset, options.area, grids, options.points, options.seed);
  const tiles = join(options.root, 'output', options.dataset.id);
  const errors: number[] = [];
  for (const grid of grids) {
    const mine = points.filter((p) => p.grid === grid);
    if (mine.length === 0) continue;
    gdalBilinear(options.image, options.root, grid, mine).forEach((expected, i) => {
      errors.push(Math.abs(outputHeight(tiles, mine[i] as Point) - expected));
    });
  }
  const maxErrorM = Math.max(0, ...errors);
  return {
    points: errors.length,
    maxErrorM,
    meanErrorM: errors.reduce((a, b) => a + b, 0) / Math.max(1, errors.length),
    toleranceM: TERRAIN_TOLERANCE_M,
    passed: errors.length === options.points && maxErrorM <= TERRAIN_TOLERANCE_M,
  };
}

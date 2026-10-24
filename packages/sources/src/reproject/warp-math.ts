// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * The pure geometry of client-side reprojection (F226): where a target tile falls in a source reference system, which
 * source image to fetch for it, and the piecewise-affine warp (a grid of triangles, each with the affine map from
 * source-image pixels to tile pixels) that draws that image into the tile. No canvas, no DOM: unit-testable in Node.
 */
import type { TileRectangleRad } from '@vibeglobe/core';

/** Maps a WGS84 longitude and latitude (degrees) to coordinates of the source reference system. */
export type ToSource = (lonDeg: number, latDeg: number) => readonly [number, number];
/** Maps coordinates of the source reference system to a WGS84 longitude and latitude (degrees). */
export type FromSource = (x: number, y: number) => readonly [number, number];
/** A box in source reference-system units: west, south, east, north (easting and northing for projected systems). */
export type SourceBbox = readonly [west: number, south: number, east: number, north: number];
/** The target tiling: Web Mercator XYZ or the two-root geographic pyramid. */
export type TargetTiling = 'mercator' | 'geographic';
/** A 2D affine map in canvas `setTransform(a, b, c, d, e, f)` order: x' = a x + c y + e, y' = b x + d y + f. */
export type Affine = readonly [a: number, b: number, c: number, d: number, e: number, f: number];
/** Three points as a flat array: x0, y0, x1, y1, x2, y2. */
export type Triangle = readonly [number, number, number, number, number, number];

/** One triangle of the warp: its clip polygon in tile pixels and the map from source-image pixels to tile pixels. */
export interface WarpTriangle {
  /** The three corners in tile pixels, widened slightly so neighbors overlap and no antialiased seam shows. */
  readonly clipPx: Triangle;
  /** Source-image pixels to tile pixels. */
  readonly transform: Affine;
}

/** Everything the canvas step needs to draw one tile. */
export interface WarpPlan {
  readonly tileSizePx: number;
  /** The source image to fetch: its box in source units and its size in pixels. */
  readonly imageBbox: SourceBbox;
  readonly imageWidthPx: number;
  readonly imageHeightPx: number;
  readonly triangles: readonly WarpTriangle[];
}

/** Inputs of {@link planWarp}. */
export interface WarpPlanInput {
  readonly extent: TileRectangleRad;
  readonly tiling: TargetTiling;
  readonly tileSizePx: number;
  readonly toSource: ToSource;
  /** Where the source has data, in source units. */
  readonly bounds: SourceBbox;
  /** Cells per tile side of the warp grid (default 16). */
  readonly gridCells?: number;
  /** Points per tile side sampled for the footprint (default 9). */
  readonly footprintSamples?: number;
  /** The largest source image side, pixels (default twice the tile size). */
  readonly maxImagePx?: number;
}

const DEG = 180 / Math.PI;
/** How far each clip triangle is widened beyond its edges, tile pixels. */
const CLIP_OVERLAP_PX = 0.75;
/** Source pixels fetched beyond the footprint on every side, so filtering at the tile edge has data. */
const MARGIN_PX = 2;

function mercatorY(latRad: number): number {
  return Math.log(Math.tan(Math.PI / 4 + latRad / 2));
}

/**
 * The longitude and latitude (degrees) of a point of a tile, `u` and `v` from 0 to 1 across it from the north-west
 * corner: linear in latitude for the geographic tiling, linear in Mercator y for Web Mercator.
 */
export function tilePointLonLat(
  extent: TileRectangleRad,
  tiling: TargetTiling,
  u: number,
  v: number,
): [lonDeg: number, latDeg: number] {
  const lonRad = extent.westRad + (extent.eastRad - extent.westRad) * u;
  if (tiling === 'geographic') return [lonRad * DEG, (extent.northRad + (extent.southRad - extent.northRad) * v) * DEG];
  const north = mercatorY(extent.northRad);
  const south = mercatorY(extent.southRad);
  return [lonRad * DEG, Math.atan(Math.sinh(north + (south - north) * v)) * DEG];
}

/** `toSource` that answers undefined instead of throwing or returning non-finite values. */
function project(toSource: ToSource, lonDeg: number, latDeg: number): readonly [number, number] | undefined {
  try {
    const p = toSource(lonDeg, latDeg);
    return Number.isFinite(p[0]) && Number.isFinite(p[1]) ? p : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The bounding box in source units of a tile's footprint, from `samples` × `samples` points of the tile mapped with
 * `toSource`; undefined when no point maps.
 */
function sourceFootprint(
  extent: TileRectangleRad,
  tiling: TargetTiling,
  toSource: ToSource,
  samples = 9,
): SourceBbox | undefined {
  let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let j = 0; j < samples; j++) {
    for (let i = 0; i < samples; i++) {
      const [lon, lat] = tilePointLonLat(extent, tiling, i / (samples - 1), j / (samples - 1));
      const p = project(toSource, lon, lat);
      if (!p) continue;
      [w, s, e, n] = [Math.min(w, p[0]), Math.min(s, p[1]), Math.max(e, p[0]), Math.max(n, p[1])];
    }
  }
  return w <= e && s <= n ? [w, s, e, n] : undefined;
}

/** The box in source units enclosing a longitude-latitude rectangle (degrees), from points along its edges. */
export function sourceBoundsOf(
  [west, south, east, north]: readonly [number, number, number, number],
  toSource: ToSource,
  samples = 33,
): SourceBbox {
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let k = 0; k < samples; k++) {
    const t = k / (samples - 1);
    for (const [lon, lat] of [
      [west + (east - west) * t, south],
      [west + (east - west) * t, north],
      [west, south + (north - south) * t],
      [east, south + (north - south) * t],
    ] as const) {
      const [x, y] = toSource(lon, lat);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      [minX, minY, maxX, maxY] = [Math.min(minX, x), Math.min(minY, y), Math.max(maxX, x), Math.max(maxY, y)];
    }
  }
  return [minX, minY, maxX, maxY];
}

/**
 * The longitude-latitude rectangle (radians) of a box of the source reference system, from `samples` points along
 * each edge mapped with `fromSource` (projected edges curve, so their extremes can lie between the corners).
 */
export function lonLatBoundsOf(bounds: SourceBbox, fromSource: FromSource, samples = 33): TileRectangleRad {
  const [w, s, e, n] = bounds;
  let [west, south, east, north] = [Infinity, Infinity, -Infinity, -Infinity];
  const add = (x: number, y: number): void => {
    const [lon, lat] = fromSource(x, y);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
    [west, south, east, north] = [Math.min(west, lon), Math.min(south, lat), Math.max(east, lon), Math.max(north, lat)];
  };
  for (let k = 0; k < samples; k++) {
    const t = k / (samples - 1);
    add(w + (e - w) * t, s);
    add(w + (e - w) * t, n);
    add(w, s + (n - s) * t);
    add(e, s + (n - s) * t);
  }
  return { westRad: west / DEG, southRad: south / DEG, eastRad: east / DEG, northRad: north / DEG };
}

/**
 * The affine map taking the three points `from` onto the three points `to` exactly (flat arrays x0, y0, x1, y1, x2,
 * y2), in canvas `setTransform` order; undefined when `from` is degenerate (collinear).
 */
export function solveAffine(from: Triangle, to: Triangle): Affine | undefined {
  const [x0, y0, x1, y1, x2, y2] = from;
  const [u0, v0, u1, v1, u2, v2] = to;
  const det = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
  if (Math.abs(det) < 1e-12) return undefined;
  // Solve [a c; b d] from the two edge vectors, then the translation from the first point.
  const a = ((u1 - u0) * (y2 - y0) - (u2 - u0) * (y1 - y0)) / det;
  const c = ((u2 - u0) * (x1 - x0) - (u1 - u0) * (x2 - x0)) / det;
  const b = ((v1 - v0) * (y2 - y0) - (v2 - v0) * (y1 - y0)) / det;
  const d = ((v2 - v0) * (x1 - x0) - (v1 - v0) * (x2 - x0)) / det;
  return [a, b, c, d, u0 - a * x0 - c * y0, v0 - b * x0 - d * y0];
}

/** Applies an affine map to a point. */
export function applyAffine(m: Affine, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** The triangle widened by `px` beyond each corner, away from its centroid. */
function widen(t: Triangle, px: number): Triangle {
  const cx = (t[0] + t[2] + t[4]) / 3;
  const cy = (t[1] + t[3] + t[5]) / 3;
  const out: [number, number, number, number, number, number] = [t[0], t[1], t[2], t[3], t[4], t[5]];
  for (let k = 0; k < 6; k += 2) {
    const x = out[k] ?? 0;
    const y = out[k + 1] ?? 0;
    const length = Math.hypot(x - cx, y - cy) || 1;
    out[k] = x + ((x - cx) / length) * px * 2;
    out[k + 1] = y + ((y - cy) / length) * px * 2;
  }
  return out;
}

/**
 * Plans the warp of one tile: the tile's footprint in source units (widened by a margin and cut to `bounds`), the
 * source image size (about the tile's resolution, capped), and for each of the grid's 2 × N × N triangles the affine
 * map from source-image pixels to tile pixels through its three corners. Undefined when the tile misses the data.
 */
export function planWarp(input: WarpPlanInput): WarpPlan | undefined {
  const { extent, tiling, tileSizePx: size, toSource, bounds } = input;
  const cells = input.gridCells ?? 16;
  const footprint = sourceFootprint(extent, tiling, toSource, input.footprintSamples ?? 9);
  if (!footprint) return undefined;
  const unitsPerPx = Math.max(footprint[2] - footprint[0], footprint[3] - footprint[1]) / size;
  if (!(unitsPerPx > 0)) return undefined;
  const margin = unitsPerPx * MARGIN_PX;
  const box: SourceBbox = [
    Math.max(bounds[0], footprint[0] - margin),
    Math.max(bounds[1], footprint[1] - margin),
    Math.min(bounds[2], footprint[2] + margin),
    Math.min(bounds[3], footprint[3] + margin),
  ];
  if (box[0] >= box[2] || box[1] >= box[3]) return undefined;
  const maxPx = input.maxImagePx ?? 2 * size;
  const width = Math.max(1, Math.min(maxPx, Math.ceil((box[2] - box[0]) / unitsPerPx)));
  const height = Math.max(1, Math.min(maxPx, Math.ceil((box[3] - box[1]) / unitsPerPx)));
  // Corner grid: tile pixel → source-image pixel (NaN where `toSource` fails).
  const corners = new Float64Array((cells + 1) * (cells + 1) * 2);
  for (let j = 0; j <= cells; j++) {
    for (let i = 0; i <= cells; i++) {
      const [lon, lat] = tilePointLonLat(extent, tiling, i / cells, j / cells);
      const p = project(toSource, lon, lat);
      const k = (j * (cells + 1) + i) * 2;
      corners[k] = p ? ((p[0] - box[0]) / (box[2] - box[0])) * width : NaN;
      corners[k + 1] = p ? ((box[3] - p[1]) / (box[3] - box[1])) * height : NaN;
    }
  }
  const step = size / cells;
  const triangles: WarpTriangle[] = [];
  const at = (i: number, j: number): number => (j * (cells + 1) + i) * 2;
  const add = (i0: number, j0: number, i1: number, j1: number, i2: number, j2: number): void => {
    const [k0, k1, k2] = [at(i0, j0), at(i1, j1), at(i2, j2)];
    const source: Triangle = [
      corners[k0] ?? NaN,
      corners[k0 + 1] ?? NaN,
      corners[k1] ?? NaN,
      corners[k1 + 1] ?? NaN,
      corners[k2] ?? NaN,
      corners[k2 + 1] ?? NaN,
    ];
    if (!source.every(Number.isFinite)) return;
    const xs = [source[0], source[2], source[4]];
    const ys = [source[1], source[3], source[5]];
    // Skip triangles entirely outside the image: nothing of the source is drawn there.
    if (xs.every((x) => x < 0) || xs.every((x) => x > width)) return;
    if (ys.every((y) => y < 0) || ys.every((y) => y > height)) return;
    const target: Triangle = [i0 * step, j0 * step, i1 * step, j1 * step, i2 * step, j2 * step];
    const transform = solveAffine(source, target);
    if (transform) triangles.push({ clipPx: widen(target, CLIP_OVERLAP_PX), transform });
  };
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      add(i, j, i + 1, j, i, j + 1);
      add(i + 1, j, i + 1, j + 1, i, j + 1);
    }
  }
  return { tileSizePx: size, imageBbox: box, imageWidthPx: width, imageHeightPx: height, triangles };
}

// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * Images of raster-like style layers (F445, ADR 0133), made on the CPU and drawn as textured tile squares: hillshade
 * shading and color relief (hypsometric tint) from a raster-dem tile, and heatmap densities of a tile's points colored by
 * `heatmap-color`. All are straight sRGB RGBA, top row first.
 */
import type { StyleColor, StyleLayer } from './style-layer.js';
import type { RasterImage } from './vector-target.js';

/** Elevation encodings of raster-dem sources. */
export type DemEncoding = 'mapbox' | 'terrarium';

/** Heights in meters of an RGBA DEM image. */
export function decodeDem(rgba: ArrayLike<number>, encoding: DemEncoding): Float32Array {
  const heights = new Float32Array(rgba.length / 4);
  for (let i = 0; i < heights.length; i++) {
    const r = rgba[i * 4] ?? 0;
    const g = rgba[i * 4 + 1] ?? 0;
    const b = rgba[i * 4 + 2] ?? 0;
    heights[i] = encoding === 'terrarium' ? r * 256 + g + b / 256 - 32768 : -10000 + (r * 65536 + g * 256 + b) * 0.1;
  }
  return heights;
}

/** A style color in 0–255 RGB and 0–1 alpha; of a list (hillshade's colors per light direction), the first. */
const color255 = (value: unknown): [number, number, number, number] => {
  const c = (Array.isArray(value) ? value[0] : value) as StyleColor | undefined;
  return c === undefined || typeof c.r !== 'number' ? [0, 0, 0, 0] : [c.r * 255, c.g * 255, c.b * 255, c.a];
};

/** Meters per pixel of a tile image of `size` pixels at tile zoom `z`, at the tile's center latitude. */
function pixelMeters(z: number, y: number, size: number): number {
  const n = 2 ** z;
  const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / n)));
  return (40_075_016.686 * Math.cos(lat)) / n / size;
}

/**
 * Hillshade shading of a DEM tile: each pixel's surface normal (from its neighbors' heights, scaled by
 * `hillshade-exaggeration`) lit from `hillshade-illumination-direction` at 45° above the horizon. Slopes facing the
 * light take the highlight color, slopes facing away the shadow color, with alpha growing with the difference from
 * flat ground; steep slopes add the accent color.
 */
export function hillshadeImage(
  heights: Float32Array,
  size: number,
  tile: { readonly z: number; readonly y: number },
  layer: StyleLayer,
  zoom: number,
): RasterImage {
  const p = (name: string) => layer.paint(name, zoom);
  const exaggeration = Number(p('hillshade-exaggeration') ?? 0.5);
  const direction = p('hillshade-illumination-direction');
  const azimuth = (Number((Array.isArray(direction) ? direction[0] : direction) ?? 335) * Math.PI) / 180;
  const shadow = color255(p('hillshade-shadow-color'));
  const highlight = color255(p('hillshade-highlight-color'));
  const accent = color255(p('hillshade-accent-color'));
  const altitude = Math.PI / 4;
  const light = [Math.sin(azimuth) * Math.cos(altitude), Math.cos(azimuth) * Math.cos(altitude), Math.sin(altitude)];
  const cell = pixelMeters(tile.z, tile.y, size);
  const scale = 1 + 2 * exaggeration;
  const at = (x: number, y: number) =>
    heights[Math.min(size - 1, Math.max(0, y)) * size + Math.min(size - 1, Math.max(0, x))] ?? 0;
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // East and north gradients (image rows run south).
      // Central differences, one-sided at the image's border (no seam of halved slopes along tile edges).
      const x0 = Math.max(0, x - 1);
      const x1 = Math.min(size - 1, x + 1);
      const y0 = Math.max(0, y - 1);
      const y1 = Math.min(size - 1, y + 1);
      const east = ((at(x1, y) - at(x0, y)) / ((x1 - x0) * cell)) * scale;
      const north = ((at(x, y0) - at(x, y1)) / ((y1 - y0) * cell)) * scale;
      const length = Math.hypot(east, north, 1);
      const nz = 1 / length;
      const lit = (-east * (light[0] ?? 0) - north * (light[1] ?? 0) + (light[2] ?? 0)) / length;
      const shade = lit - (light[2] ?? 0);
      const base = shade >= 0 ? highlight : shadow;
      const amount = Math.min(1, Math.abs(shade) * 1.5) * (base[3] ?? 1);
      const steep = (1 - nz) * 0.3 * (accent[3] ?? 0);
      const alpha = amount + steep * (1 - amount);
      const mixRgb = (i: number) => ((base[i] ?? 0) * amount + (accent[i] ?? 0) * steep * (1 - amount)) / (alpha || 1);
      const o = (y * size + x) * 4;
      data[o] = mixRgb(0);
      data[o + 1] = mixRgb(1);
      data[o + 2] = mixRgb(2);
      data[o + 3] = alpha * 255;
    }
  }
  return { width: size, height: size, data };
}

/** Steps of the elevation ramp a color-relief image reads its colors from, between the tile's lowest and highest. */
const RELIEF_STEPS = 256;

/**
 * Color relief of a DEM tile: each pixel colored by `color-relief-color` at its elevation (`["elevation"]`, meters),
 * read from a ramp over the tile's range of heights; `color-relief-opacity` is the draw's.
 */
export function colorReliefImage(heights: Float32Array, size: number, layer: StyleLayer, zoom: number): RasterImage {
  let low = Infinity;
  let high = -Infinity;
  for (const h of heights) {
    if (h < low) low = h;
    if (h > high) high = h;
  }
  const span = high > low ? high - low : 1;
  const ramp = Array.from({ length: RELIEF_STEPS }, (_, i) =>
    color255(
      layer.paint('color-relief-color', zoom, undefined, undefined, {
        elevation: low + (span * i) / (RELIEF_STEPS - 1),
      }),
    ),
  );
  const data = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const c = ramp[Math.round((((heights[i] ?? low) - low) / span) * (RELIEF_STEPS - 1))] ?? [0, 0, 0, 0];
    data.set([c[0], c[1], c[2], (c[3] ?? 0) * 255], i * 4);
  }
  return { width: size, height: size, data };
}

/** A point of a heatmap tile: tile units (extent 4096) and its weight. */
export interface HeatmapPoint {
  readonly x: number;
  readonly y: number;
  readonly weight: number;
}

/** Cells per side of a heatmap tile image. */
const HEATMAP_CELLS = 128;
const EXTENT = 4096;

/**
 * The heatmap of a tile's points at `zoom`: Gaussian kernels of `heatmap-radius` CSS pixels (3 σ), scaled by the
 * points' weights and `heatmap-intensity`, summed into densities that `heatmap-color` colors (density clamped to 0–1).
 * `tilePx` is the tile's size in CSS pixels at that zoom. Points of the tile's buffer contribute near its edges.
 */
export function heatmapImage(
  points: readonly HeatmapPoint[],
  tilePx: number,
  layer: StyleLayer,
  zoom: number,
): RasterImage {
  const n = HEATMAP_CELLS;
  const radiusCells = (Number(layer.paint('heatmap-radius', zoom) ?? 30) * n) / tilePx;
  const intensity = Number(layer.paint('heatmap-intensity', zoom) ?? 1);
  const sigma = Math.max(radiusCells / 3, 1e-3);
  const density = new Float32Array(n * n);
  const reach = Math.ceil(radiusCells);
  for (const point of points) {
    const cx = (point.x / EXTENT) * n - 0.5;
    const cy = (point.y / EXTENT) * n - 0.5;
    for (let y = Math.max(0, Math.floor(cy - reach)); y <= Math.min(n - 1, Math.ceil(cy + reach)); y++)
      for (let x = Math.max(0, Math.floor(cx - reach)); x <= Math.min(n - 1, Math.ceil(cx + reach)); x++) {
        const d2 = (x - cx) ** 2 + (y - cy) ** 2;
        if (d2 > radiusCells * radiusCells) continue;
        density[y * n + x] = (density[y * n + x] ?? 0) + point.weight * intensity * Math.exp(-d2 / (2 * sigma * sigma));
      }
  }
  const ramp = Array.from({ length: 256 }, (_, i) =>
    color255(layer.paint('heatmap-color', zoom, undefined, undefined, { heatmapDensity: i / 255 })),
  );
  const data = new Uint8ClampedArray(n * n * 4);
  for (let i = 0; i < n * n; i++) {
    const c = ramp[Math.round(Math.min(1, Math.max(0, density[i] ?? 0)) * 255)] ?? [0, 0, 0, 0];
    data.set([c[0], c[1], c[2], (c[3] ?? 0) * 255], i * 4);
  }
  return { width: n, height: n, data };
}

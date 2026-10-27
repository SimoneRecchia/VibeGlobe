// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * Sampling a set of georeferenced rasters as one surface: bilinear interpolation between sample centers, across file
 * borders, with a small cache of decoded files.
 */
import type { BBoxDeg } from '../tiles/mercator.js';
import type { Raster } from './tiff.js';

/** One source of a mosaic: its extent and a loader (`undefined` for a file known to have no data). */
export interface MosaicEntry {
  bounds: BBoxDeg;
  load: () => Raster | undefined;
}

/** Whether a point lies inside a raster's own extent. */
function contains(raster: Raster, lon: number, lat: number): boolean {
  const east = raster.westDeg + raster.width * raster.pixelWidthDeg;
  const south = raster.northDeg - raster.height * raster.pixelHeightDeg;
  return lon >= raster.westDeg && lon < east && lat > south && lat <= raster.northDeg;
}

/** A mosaic of rasters with `channels` samples per pixel and a value for areas without data. */
export class Mosaic {
  private readonly cache = new Map<MosaicEntry, Raster | undefined>();
  private last: Raster | undefined;

  constructor(
    private readonly entries: MosaicEntry[],
    readonly channels: number,
    private readonly fill: number[],
    private readonly cacheSize = 6,
  ) {}

  /** The decoded raster of an entry, through the cache. */
  private raster(entry: MosaicEntry): Raster | undefined {
    if (this.cache.has(entry)) {
      const raster = this.cache.get(entry);
      this.cache.delete(entry);
      this.cache.set(entry, raster);
      return raster;
    }
    const raster = entry.load();
    this.cache.set(entry, raster);
    if (this.cache.size > this.cacheSize) this.cache.delete(this.cache.keys().next().value as MosaicEntry);
    return raster;
  }

  /**
   * The raster whose own extent contains a point. Entry bounds are nominal (a pixel-is-point file reaches half a pixel
   * beyond its cell), so nearby entries are loaded and their real extents decide.
   */
  private rasterAt(lon: number, lat: number): Raster | undefined {
    // Consecutive samples nearly always fall in the raster of the previous one.
    const last = this.last;
    if (last && contains(last, lon, lat)) return last;
    const found = this.searchRaster(lon, lat);
    if (found) this.last = found;
    return found;
  }

  private searchRaster(lon: number, lat: number): Raster | undefined {
    const margin = 1e-3;
    for (const entry of this.entries) {
      const b = entry.bounds;
      if (lon < b.west - margin || lon >= b.east + margin || lat <= b.south - margin || lat > b.north + margin)
        continue;
      const raster = this.raster(entry);
      if (raster && contains(raster, lon, lat)) return raster;
    }
    return undefined;
  }

  /** Nearest source pixel value at a point (used for the corners of a cross-file interpolation). */
  private pixelAt(lon: number, lat: number, channel: number): number {
    const raster = this.rasterAt(lon, lat);
    if (!raster) return this.fill[channel] ?? 0;
    const col = Math.min(raster.width - 1, Math.max(0, Math.floor((lon - raster.westDeg) / raster.pixelWidthDeg)));
    const row = Math.min(raster.height - 1, Math.max(0, Math.floor((raster.northDeg - lat) / raster.pixelHeightDeg)));
    return this.valueOf(raster, row * raster.width + col, channel);
  }

  private valueOf(raster: Raster, pixel: number, channel: number): number {
    const value = raster.data[pixel * raster.samplesPerPixel + channel] ?? 0;
    return raster.noData !== undefined && value === raster.noData ? (this.fill[channel] ?? 0) : value;
  }

  /** Pixel size of the raster covering a point, in degrees of longitude, or `undefined` outside the data. */
  pixelSizeAt(lon: number, lat: number): number | undefined {
    const raster = this.rasterAt(lon, lat);
    return raster?.pixelWidthDeg;
  }

  /** Bilinear sample of every channel at a point into `out`. */
  sample(lon: number, lat: number, out: Float64Array): void {
    const raster = this.rasterAt(lon, lat);
    if (!raster) {
      for (let c = 0; c < this.channels; c++) out[c] = this.fill[c] ?? 0;
      return;
    }
    const fx = (lon - raster.westDeg) / raster.pixelWidthDeg - 0.5;
    const fy = (raster.northDeg - lat) / raster.pixelHeightDeg - 0.5;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const inside = x0 >= 0 && y0 >= 0 && x0 + 1 < raster.width && y0 + 1 < raster.height;
    for (let c = 0; c < this.channels; c++) {
      let v00: number, v10: number, v01: number, v11: number;
      if (inside) {
        const at = y0 * raster.width + x0;
        v00 = this.valueOf(raster, at, c);
        v10 = this.valueOf(raster, at + 1, c);
        v01 = this.valueOf(raster, at + raster.width, c);
        v11 = this.valueOf(raster, at + raster.width + 1, c);
      } else {
        // Near a file border the four neighbors may live in different files.
        const lonOf = (x: number): number => raster.westDeg + (x + 0.5) * raster.pixelWidthDeg;
        const latOf = (y: number): number => raster.northDeg - (y + 0.5) * raster.pixelHeightDeg;
        v00 = this.pixelAt(lonOf(x0), latOf(y0), c);
        v10 = this.pixelAt(lonOf(x0 + 1), latOf(y0), c);
        v01 = this.pixelAt(lonOf(x0), latOf(y0 + 1), c);
        v11 = this.pixelAt(lonOf(x0 + 1), latOf(y0 + 1), c);
      }
      out[c] = (v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty;
    }
  }
}

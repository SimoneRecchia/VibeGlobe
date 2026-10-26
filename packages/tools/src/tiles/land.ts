// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * Land and sea tiles of a region: which tiles of each zoom touch land (a land mask such as Natural Earth's), so a build
 * keeps every tile up to the sea's last zoom and only land tiles beyond it. The mask is one bitmap at the deepest
 * zoom, each coarser zoom the OR of 2×2 blocks below it: exact counts without listing millions of tiles.
 */
import { edgeTiles, interiorTiles, type Ring, ringToTileSpace } from './area.js';
import { type BBoxDeg, type TileCoord, type TileRange, rangeCount, rangeTiles, tileRange } from './mercator.js';

interface Level {
  readonly range: TileRange;
  readonly width: number;
  readonly bits: Uint8Array;
  readonly count: number;
}

/** The land tiles of a region at every zoom up to `maxZoom`. */
export class LandMask {
  private readonly levels = new Map<number, Level>();

  /** `rings`: the land polygons' rings (outer rings and holes, even-odd); `region`: the build's bounding box. */
  constructor(
    rings: readonly Ring[],
    private readonly region: BBoxDeg,
    readonly maxZoom: number,
  ) {
    const range = tileRange(region, maxZoom);
    const width = range.maxX - range.minX + 1;
    const height = range.maxY - range.minY + 1;
    const bits = new Uint8Array(width * height);
    const tileRings = rings.map((ring) => ringToTileSpace(ring, maxZoom));
    const mark = (x: number, y: number): void => {
      bits[(y - range.minY) * width + (x - range.minX)] = 1;
    };
    edgeTiles(tileRings, range, mark);
    interiorTiles(tileRings, range, mark);
    this.levels.set(maxZoom, { range, width, bits, count: bits.reduce((n, b) => n + b, 0) });
  }

  private level(z: number): Level {
    const found = this.levels.get(z);
    if (found) return found;
    if (z > this.maxZoom) throw new Error(`the land mask goes to zoom ${this.maxZoom}, not ${z}`);
    const finer = this.level(z + 1);
    const range = tileRange(this.region, z);
    const width = range.maxX - range.minX + 1;
    const bits = new Uint8Array(width * (range.maxY - range.minY + 1));
    let count = 0;
    for (let y = finer.range.minY; y <= finer.range.maxY; y++)
      for (let x = finer.range.minX; x <= finer.range.maxX; x++) {
        if (finer.bits[(y - finer.range.minY) * finer.width + (x - finer.range.minX)] !== 1) continue;
        const px = (x >> 1) - range.minX;
        const py = (y >> 1) - range.minY;
        if (px < 0 || py < 0 || px >= width) continue;
        const i = py * width + px;
        if (bits[i] !== 1) {
          bits[i] = 1;
          count++;
        }
      }
    const level = { range, width, bits, count };
    this.levels.set(z, level);
    return level;
  }

  /** Tiles of the region at `z` that touch land. */
  landCount(z: number): number {
    return this.level(z).count;
  }

  /** Tiles of the region at `z` that touch no land. */
  seaCount(z: number): number {
    return rangeCount(tileRange(this.region, z)) - this.landCount(z);
  }

  /** Whether the tile touches land. */
  isLand(tile: TileCoord): boolean {
    const level = this.level(tile.z);
    const { range } = level;
    if (tile.x < range.minX || tile.x > range.maxX || tile.y < range.minY || tile.y > range.maxY) return false;
    return level.bits[(tile.y - range.minY) * level.width + (tile.x - range.minX)] === 1;
  }

  /** The tiles of the region a build keeps at `z`: all of them up to `seaMaxZoom`, only land beyond. */
  *tiles(z: number, seaMaxZoom: number): Generator<TileCoord> {
    for (const tile of rangeTiles(tileRange(this.region, z))) if (z <= seaMaxZoom || this.isLand(tile)) yield tile;
  }
}

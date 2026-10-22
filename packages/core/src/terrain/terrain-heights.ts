import type { HeightGrid } from './heightmap.js';
import { sampleHeight } from './sample-height.js';
import type { TerrainLayer } from './terrain-draws.js';

/** An elevation query's answer (F144, F145). */
export interface ElevationSample {
  /** Meters above the WGS84 ellipsoid; 0 (the ellipsoid, ADR 0024's no-data surface) where there is no terrain. */
  heightMeters: number;
  /** The terrain level the height came from, -1 without terrain. */
  level: number;
  /** True where no terrain covers the position (or none is resident yet): the height is the no-data surface's. */
  noData: boolean;
}

/** {@link TerrainHeights.wantFinest}: the finest tile with data is resident (or no level has data). */
const FINEST_RESIDENT = -1;
/** {@link TerrainHeights.wantFinest}: the finest tile failed for good. */
export const FINEST_FAILED = -2;

/** Where a position falls in a tiling at a level: column, row, and u, v across the tile (v from the north). */
const located = new Float64Array(4);

/** Writes the tile and in-tile position of a geodetic position at `level` into {@link located}. */
function locate(mercator: boolean, lonRad: number, latRad: number, level: number): void {
  const n = 2 ** level;
  let fx: number;
  let fy: number;
  if (mercator) {
    const limit = 1.4844222297453324; // 85.0511287798° in radians: Mercator-only terrain continues its edge heights.
    const lat = latRad > limit ? limit : latRad < -limit ? -limit : latRad;
    fx = ((lonRad + Math.PI) / (2 * Math.PI)) * n;
    fy = ((1 - Math.log(Math.tan(Math.PI / 4 + lat / 2)) / Math.PI) / 2) * n;
  } else {
    const step = Math.PI / n;
    fx = (lonRad + Math.PI) / step;
    fy = (Math.PI / 2 - latRad) / step;
  }
  const columns = mercator ? n : 2 * n;
  let x = Math.floor(fx);
  let y = Math.floor(fy);
  if (x >= columns) x = columns - 1;
  if (x < 0) x = 0;
  if (y >= n) y = n - 1;
  if (y < 0) y = 0;
  located[0] = x;
  located[1] = y;
  located[2] = fx - x;
  located[3] = fy - y;
}

/**
 * The CPU copies of the resident terrain height grids, by texture handle, and the elevation queries on them (ADR 0006
 * §5: the same piecewise-linear function as the shader, `sampleHeight`).
 */
export class TerrainHeights {
  private readonly grids = new Map<number, HeightGrid>();

  constructor(private readonly layer: TerrainLayer) {}

  /** Keeps the grid of a tile uploaded under `handle`. */
  add(handle: number, grid: HeightGrid): void {
    this.grids.set(handle, grid);
  }

  /** The grid of a resident tile by handle. */
  grid(handle: number): HeightGrid | undefined {
    return this.grids.get(handle);
  }

  /** Forgets a released tile's grid. */
  remove(handle: number): void {
    this.grids.delete(handle);
  }

  /**
   * The height at a position from the deepest resident terrain tile that contains it, written into `out` (F144).
   * Allocates nothing.
   */
  sample(lonRad: number, latRad: number, out: ElevationSample): ElevationSample {
    const { source, loader } = this.layer;
    const mercator = source.tiling.crs === 'EPSG:3857';
    for (let level = source.maxLevel; level >= source.minLevel; level--) {
      locate(mercator, lonRad, latRad, level);
      const handle = loader.peekHandle(level, located[0] ?? 0, located[1] ?? 0);
      const grid = handle >= 0 ? this.grids.get(handle) : undefined;
      if (!grid) continue;
      out.heightMeters = sampleHeight(grid, located[2] ?? 0, located[3] ?? 0);
      out.level = level;
      out.noData = false;
      return out;
    }
    out.heightMeters = 0;
    out.level = -1;
    out.noData = true;
    return out;
  }

  /**
   * Wants the finest tile of a position the source may still deliver: the deepest level whose tile is neither resident
   * nor known to have no data, at `priority`. Returns that level, {@link FINEST_RESIDENT} once the finest tile with
   * data is resident, or {@link FINEST_FAILED} when it failed for good (F145).
   */
  wantFinest(lonRad: number, latRad: number, priority: number): number {
    const { source, loader } = this.layer;
    const mercator = source.tiling.crs === 'EPSG:3857';
    for (let level = source.maxLevel; level >= source.minLevel; level--) {
      locate(mercator, lonRad, latRad, level);
      const x = located[0] ?? 0;
      const y = located[1] ?? 0;
      if (loader.peekHandle(level, x, y) >= 0) return FINEST_RESIDENT;
      if (loader.failed(level, x, y)) return FINEST_FAILED;
      if (loader.noData(level, x, y)) continue;
      loader.want(level, x, y, priority);
      return level;
    }
    return FINEST_RESIDENT;
  }
}

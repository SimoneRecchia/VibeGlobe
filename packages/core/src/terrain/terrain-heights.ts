import type { HeightGrid } from './heightmap.js';
import { sampleHeightInto } from './sample-height.js';
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

/**
 * Where a position falls in a tiling: across the whole tiling (0–1), then at one level its column and row, a spare
 * slot, u and v across the tile (v from the north) and the height sampled there.
 */
const located = new Float64Array(8);
/** A position in radians for {@link TerrainHeights.sample} and {@link TerrainHeights.wantFinest}. */
const position = new Float64Array(2);

/**
 * Writes the position `at[0..1]` (radians) across the whole tiling into `located[0..1]`, 0–1 from the west and from
 * the north; once per query, so each level only scales it.
 */
function project(mercator: boolean, at: Float64Array): void {
  const lonRad = at[0] ?? 0;
  const latRad = at[1] ?? 0;
  if (mercator) {
    const limit = 1.4844222297453324; // 85.0511287798° in radians: Mercator-only terrain continues its edge heights.
    const lat = latRad > limit ? limit : latRad < -limit ? -limit : latRad;
    located[0] = (lonRad + Math.PI) / (2 * Math.PI);
    located[1] = (1 - Math.log(Math.tan(Math.PI / 4 + lat / 2)) / Math.PI) / 2;
  } else {
    located[0] = (lonRad + Math.PI) / (2 * Math.PI);
    located[1] = (Math.PI / 2 - latRad) / Math.PI;
  }
}

/**
 * Writes the tile and in-tile position at `level` of the position {@link project} wrote: column and row into
 * `located[2..3]`, u and v across the tile into `located[5..6]` (the sampled height then goes to `located[7]`).
 */
function locate(mercator: boolean, level: number): void {
  const n = 2 ** level;
  const columns = mercator ? n : 2 * n;
  const fx = (located[0] ?? 0) * columns;
  const fy = (located[1] ?? 0) * n;
  let x = Math.floor(fx);
  let y = Math.floor(fy);
  if (x >= columns) x = columns - 1;
  if (x < 0) x = 0;
  if (y >= n) y = n - 1;
  if (y < 0) y = 0;
  located[2] = x;
  located[3] = y;
  located[5] = fx - x;
  located[6] = fy - y;
}

/**
 * The CPU copies of the resident terrain height grids, by texture handle, and the elevation queries on them (ADR 0006
 * §5: the same piecewise-linear function as the shader, `sampleHeight`).
 */
export class TerrainHeights {
  private readonly grids = new Map<number, HeightGrid>();
  /** Resident grids per level: queries skip the levels with none (F144). */
  private readonly perLevel: Int32Array;

  constructor(private readonly layer: TerrainLayer) {
    this.perLevel = new Int32Array(layer.source.maxLevel + 1);
  }

  /** Keeps the grid of a tile uploaded under `handle`. */
  add(handle: number, grid: HeightGrid): void {
    if (!this.grids.has(handle)) this.count(handle, 1);
    this.grids.set(handle, grid);
  }

  private count(handle: number, change: number): void {
    const level = this.layer.loader.levelOf(handle);
    if (level >= 0 && level < this.perLevel.length) this.perLevel[level] = (this.perLevel[level] ?? 0) + change;
  }

  /** The grid of a resident tile by handle. */
  grid(handle: number): HeightGrid | undefined {
    return this.grids.get(handle);
  }

  /** Forgets a released tile's grid. */
  remove(handle: number): void {
    if (this.grids.delete(handle)) this.count(handle, -1);
  }

  /**
   * The height at a position from the deepest resident terrain tile that contains it, written into `out` (F144).
   */
  sample(lonRad: number, latRad: number, out: ElevationSample): ElevationSample {
    position[0] = lonRad;
    position[1] = latRad;
    return this.sampleAt(position, out);
  }

  /**
   * {@link TerrainHeights.sample} at the position `at[0..1]` (radians): synchronous queries pass it in an array, so
   * no double crosses a call boundary, which V8 boxes (ADR 0018). Allocates nothing.
   */
  sampleAt(at: Float64Array, out: ElevationSample): ElevationSample {
    const { source, loader } = this.layer;
    const mercator = source.tiling.crs === 'EPSG:3857';
    project(mercator, at);
    const perLevel = this.perLevel;
    for (let level = source.maxLevel; level >= source.minLevel; level--) {
      if ((perLevel[level] ?? 0) === 0) continue;
      locate(mercator, level);
      const handle = loader.peekHandle(level, located[2] ?? 0, located[3] ?? 0);
      const grid = handle >= 0 ? this.grids.get(handle) : undefined;
      if (!grid) continue;
      sampleHeightInto(grid, located, 5);
      out.heightMeters = located[7] ?? 0;
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
    position[0] = lonRad;
    position[1] = latRad;
    project(mercator, position);
    for (let level = source.maxLevel; level >= source.minLevel; level--) {
      locate(mercator, level);
      const x = located[2] ?? 0;
      const y = located[3] ?? 0;
      if (loader.peekHandle(level, x, y) >= 0) return FINEST_RESIDENT;
      if (loader.failed(level, x, y)) return FINEST_FAILED;
      if (loader.noData(level, x, y)) continue;
      loader.want(level, x, y, priority);
      return level;
    }
    return FINEST_RESIDENT;
  }
}

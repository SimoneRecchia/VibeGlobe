import type { HeightGrid } from './heightmap.js';
import { sampleHeightInto } from './sample-height.js';
import type { TerrainLayer } from './terrain-draws.js';

/** An elevation query's answer (F144, F145). */
export interface ElevationSample {
  /** Meters above the WGS84 ellipsoid; 0 (the ellipsoid, ADR 0026's no-data surface) where there is no terrain. */
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
/** 2^level by level: rows of a tiling at each level. */
const ROWS = Float64Array.from({ length: 32 }, (_, level) => 2 ** level);
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
  const n = ROWS[level] ?? 1;
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
  /** The deepest level with a resident grid (or the source's minimum): queries start there. */
  private deepest = 0;
  /**
   * Per level, the area that holds resident grids across the whole tiling (0–1), as [west, east, north, south]:
   * queries outside skip the level. Grows as grids arrive and resets when the level empties, so it may cover more than what is resident.
   */
  private readonly extents: Float64Array;

  constructor(private readonly layer: TerrainLayer) {
    this.perLevel = new Int32Array(layer.source.maxLevel + 1);
    this.extents = new Float64Array(4 * (layer.source.maxLevel + 1));
  }

  /** Keeps the grid of a tile uploaded under `handle`. */
  add(handle: number, grid: HeightGrid): void {
    if (!this.grids.has(handle)) this.count(handle, 1);
    this.grids.set(handle, grid);
  }

  private count(handle: number, change: number): void {
    const coord = this.layer.loader.coordOf(handle);
    if (!coord || coord.level >= this.perLevel.length) return;
    const level = coord.level;
    const count = (this.perLevel[level] ?? 0) + change;
    this.perLevel[level] = count;
    if (change < 0) {
      while (this.deepest > 0 && (this.perLevel[this.deepest] ?? 0) === 0) this.deepest--;
      return;
    }
    if (level > this.deepest) this.deepest = level;
    // The tile's extent across the whole tiling (0–1, as `project` writes positions).
    const rows = 2 ** level;
    const columns = this.layer.source.tiling.crs === 'EPSG:3857' ? rows : 2 * rows;
    const west = coord.x / columns;
    const east = (coord.x + 1) / columns;
    const north = coord.y / rows;
    const south = (coord.y + 1) / rows;
    const e = this.extents;
    const at = 4 * level;
    if (count === 1) {
      e[at] = west;
      e[at + 1] = east;
      e[at + 2] = north;
      e[at + 3] = south;
      return;
    }
    if (west < (e[at] ?? 0)) e[at] = west;
    if (east > (e[at + 1] ?? 0)) e[at + 1] = east;
    if (north < (e[at + 2] ?? 0)) e[at + 2] = north;
    if (south > (e[at + 3] ?? 0)) e[at + 3] = south;
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
    const extents = this.extents;
    const gx = located[0] ?? 0;
    const gy = located[1] ?? 0;
    const columnsPerRow = mercator ? 1 : 2;
    for (let level = this.deepest; level >= source.minLevel; level--) {
      const e = 4 * level;
      if (
        (perLevel[level] ?? 0) === 0 ||
        gx < (extents[e] ?? 0) ||
        gx > (extents[e + 1] ?? 0) ||
        gy < (extents[e + 2] ?? 0) ||
        gy > (extents[e + 3] ?? 0)
      )
        continue;
      // The tile and the position across it at this level (locate, inlined: this loop runs per query).
      const rows = ROWS[level] ?? 1;
      const columns = columnsPerRow * rows;
      const fx = gx * columns;
      const fy = gy * rows;
      let x = Math.floor(fx);
      let y = Math.floor(fy);
      if (x >= columns) x = columns - 1;
      if (y >= rows) y = rows - 1;
      located[5] = fx - x;
      located[6] = fy - y;
      const handle = loader.peekInside(level, x, y);
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
    // The finest tile that may still arrive is wanted, and so is every coarser one down to the first resident: an
    // ancestor may carry the availability of the levels below it (F128), which says whether the finest one exists.
    let wanted = FINEST_RESIDENT;
    for (let level = source.maxLevel; level >= source.minLevel; level--) {
      locate(mercator, level);
      const x = located[2] ?? 0;
      const y = located[3] ?? 0;
      if (loader.peekHandle(level, x, y) >= 0) return wanted;
      if (loader.failed(level, x, y)) return wanted === FINEST_RESIDENT ? FINEST_FAILED : wanted;
      if (loader.noData(level, x, y)) continue;
      loader.want(level, x, y, priority);
      if (wanted === FINEST_RESIDENT) wanted = level;
    }
    return wanted;
  }
}

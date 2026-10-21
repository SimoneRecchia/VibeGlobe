import type { TileTransport, TileRequest } from '../scheduler/types.js';
import type { TileCoord } from '../tiling/tile-key.js';
import type { TileRectangleRad, TilingScheme } from '../tiling/tiling-scheme.js';

/**
 * A tiled imagery source (docs/plan/api.md, M3 plan §2.2): where its tiles come from and how they are cut. Adapters
 * such as `xyzImagery` in `@vibeglobe/sources` implement it; M7 adds provider profiles, authentication and chains.
 */
export interface ImagerySource {
  /** Unique per engine instance; part of every coalescing and cache key. */
  readonly id: string;
  readonly tiling: TilingScheme;
  /** The coarsest and finest levels the source serves. */
  readonly minLevel: number;
  readonly maxLevel: number;
  /** Tile edge in pixels (256, 512, …); with `pixelRatio` 2 a texel covers half the ground. */
  readonly tileSizePx: number;
  readonly pixelRatio: number;
  /** The areas with data: tiles outside every rectangle are never requested (F094). */
  readonly coverage?: readonly TileRectangleRad[];
  /** Fetches tile bytes; `fetchTransport()` from `@vibeglobe/sources` in browsers. */
  readonly transport: TileTransport;
  /** How the bytes are decoded in the worker pool: browser image formats, or KTX2 (ADR 0020). */
  readonly decoder: 'image' | 'ktx2';
  /**
   * Writes the URL and host of a tile into `out` and returns it, or returns 'noData' for a tile the source has no
   * data for (outside its levels or coverage), which the engine then never requests (F093, F094).
   */
  request(coord: TileCoord, out: TileRequest): TileRequest | 'noData';
}

/** True when a tile's extent overlaps at least one coverage rectangle (edges touching do not count). */
export function inCoverage(coverage: readonly TileRectangleRad[] | undefined, extent: TileRectangleRad): boolean {
  if (!coverage) return true;
  for (const area of coverage) {
    if (
      extent.westRad < area.eastRad &&
      extent.eastRad > area.westRad &&
      extent.southRad < area.northRad &&
      extent.northRad > area.southRad
    ) {
      return true;
    }
  }
  return false;
}

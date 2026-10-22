import type { TileRequest, TileTransport, TimeoutsMs } from '../scheduler/types.js';
import type { TileCoord } from '../tiling/tile-key.js';
import type { TileRectangleRad, TilingScheme } from '../tiling/tiling-scheme.js';
import type { HeightGrid } from './heightmap.js';
import type { VerticalDatum } from './vertical-datum.js';

/**
 * How a terrain source's bytes become a height grid: one of the built-in decoders, which run in the worker pool
 * (F134), or a custom decode function of a third-party adapter (F132), a pure function of the bytes that the engine
 * runs in the inline executor between frames.
 */
export type TerrainDecoder =
  | { readonly kind: 'terrarium' | 'terrain-rgb' }
  | { readonly kind: 'quantized-mesh' }
  | {
      readonly kind: 'custom';
      /** Decodes a tile's bytes to heights in meters above the source's datum; throws on undecodable bytes. */
      decode(bytes: ArrayBuffer, coord: TileCoord): HeightGrid;
    };

/**
 * A tiled terrain source (docs/plan/api.md, M4 plan): where its tiles come from, how they are cut and decoded, and
 * what its heights are measured from. Adapters such as `terrariumTerrain` and `quantizedMeshTerrain` in
 * `@vibeglobe/sources` implement it; any other encoding implements it with a custom decoder (F132).
 */
export interface TerrainSource {
  /** Unique per engine instance; part of every coalescing and cache key. */
  readonly id: string;
  readonly tiling: TilingScheme;
  readonly minLevel: number;
  readonly maxLevel: number;
  /** The areas with data: tiles outside every rectangle are never requested. */
  readonly coverage?: readonly TileRectangleRad[];
  readonly transport: TileTransport;
  readonly decoder: TerrainDecoder;
  /** What the heights are measured from; geoid heights are converted to ellipsoidal ones before meshing (F133). */
  readonly datum: VerticalDatum;
  /**
   * The geometric error of a level in meters: how far the source's surface at that level may be from the real one.
   * Selection refines a tile while this error exceeds τ_terrain pixels on screen (ADR 0006 §2, F126).
   */
  geometricErrorMeters(level: number): number;
  readonly maxRequestsPerHost?: number;
  readonly multiplexed?: boolean;
  readonly timeoutsMs?: TimeoutsMs;
  /** As {@link ImagerySource.request}: the tile's URL and host, or 'noData'. */
  request(coord: TileCoord, out: TileRequest): TileRequest | 'noData';
}

/**
 * The usual geometric error of a level: a quarter of the ground spacing between the samples of a tile of
 * `samplesPerSide` samples at that level on the equator (an estimate; ADR 0006 adds the measured decimation error).
 */
export function heightmapGeometricErrorMeters(
  level: number,
  samplesPerSide: number,
  equatorMeters: number,
  tilesAtLevel0: number,
): number {
  return (0.25 * equatorMeters) / (tilesAtLevel0 * samplesPerSide * 2 ** level);
}

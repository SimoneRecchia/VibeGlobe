import type { TileTransport, TileRequest, TimeoutsMs } from '../scheduler/types.js';
import type { TileCoord } from '../tiling/tile-key.js';
import type { TileRectangleRad, TilingScheme } from '../tiling/tiling-scheme.js';
import type { Attribution, CreditProfile } from './credits.js';

/**
 * What the tile loader needs of a tiled source, imagery or terrain: where its tiles come from and how they are cut.
 */
export interface TileSource {
  /** Unique per engine instance; part of every coalescing and cache key. */
  readonly id: string;
  readonly tiling: TilingScheme;
  /** The coarsest and finest levels the source serves. */
  readonly minLevel: number;
  readonly maxLevel: number;
  /** The areas with data: tiles outside every rectangle are never requested (F094). */
  readonly coverage?: readonly TileRectangleRad[];
  /** Fetches tile bytes; `fetchTransport()` from `@vibeglobe/sources` in browsers. */
  readonly transport: TileTransport;
  /** Requests in flight to each of the source's hosts (default 6, or 16 when `multiplexed`; F089). */
  readonly maxRequestsPerHost?: number;
  /** The hosts speak HTTP/2 or HTTP/3 (F096). */
  readonly multiplexed?: boolean;
  /** The most requests the source's hosts accept per second; the scheduler never starts more in any second (F222). */
  readonly maxRequestsPerSecond?: number;
  /** Time limits of each request; ADR 0007's 10 s to the headers and 30 s in all by default (F092). */
  readonly timeoutsMs?: TimeoutsMs;
  /**
   * Writes the URL and host of a tile into `out` and returns it, or returns 'noData' for a tile the source has no
   * data for (outside its levels or coverage), which the engine then never requests (F093, F094), or 'unknown' while
   * the source cannot tell yet (availability declared by an ancestor tile not loaded yet, F128): the engine asks
   * again when it wants the tile again. `pixelRatio` is 2 when a source with `highDpi` should return its `@2x` tile.
   */
  request(coord: TileCoord, out: TileRequest, pixelRatio?: number): TileRequest | 'noData' | 'unknown';
  /** Credits shown while the source's tiles are in view (F254). */
  readonly attribution?: readonly Attribution[];
  /** The source's requests carry credentials (headers, tokens or a session), declared by its adapter (F220). */
  readonly authenticated?: boolean;
  /** The provider profile's credit rules: a required credit is always shown (F255). */
  readonly profile?: CreditProfile;
  /**
   * Optional: the loading features that apply to the source now, as a sum of `LOAD_KEEP_IN_MEMORY` and
   * `LOAD_PREFETCH` (both when absent). Read every frame, so a change applies at once without a reload (F290);
   * `@vibeglobe/offline` resolves it from the network mode, the switches and the provider's profile (F271, F281–F285).
   */
  loadingFlags?(): number;
}

/** Tiles stay in RAM and GPU memory after they leave the screen, within the budgets (F281); off: only the working set. */
export const LOAD_KEEP_IN_MEMORY = 1;
/** Tiles around the view and at the next level load ahead, after every visible tile (F284). */
export const LOAD_PREFETCH = 2;
/** Every loading feature: the default. */
export const LOAD_ALL = LOAD_KEEP_IN_MEMORY | LOAD_PREFETCH;

/**
 * A tiled imagery source (docs/plan/api.md, M3 plan §2.2). Adapters such as `xyzImagery` in `@vibeglobe/sources`
 * implement it; M7 adds provider profiles, authentication and chains.
 */
export interface ImagerySource extends TileSource {
  /** Tile edge in pixels (256, 512, …); with `pixelRatio` 2 a texel covers half the ground. */
  readonly tileSizePx: number;
  readonly pixelRatio: number;
  /**
   * The source also serves high-DPI tiles with twice the pixels (`@2x`): on a canvas of more than one render-target
   * pixel per CSS pixel the engine asks `request` for those and judges their texels at twice the density, so they cover
   * the same ground and look the same size (F241).
   */
  readonly highDpi?: boolean;
  /**
   * True when the tiles have transparent areas (PNG or WebP with alpha, reprojected rasters): the layers below show
   * through them, so the layer is composed like a translucent one (F242, ADR 0038).
   */
  readonly transparent?: boolean;
  /** How the bytes are decoded in the worker pool: browser image formats, or KTX2 (ADR 0020). */
  readonly decoder: 'image' | 'ktx2';
}

/**
 * The worker task of an imagery source's tiles: KTX2 transcoded to the device's `formats` (ADR 0020), anything else
 * decoded as a browser image.
 */
export function imageryDecodeTask(
  source: ImagerySource,
  formats: readonly string[],
): (bytes: ArrayBuffer, contentType: string) => { task: string; input: unknown } {
  return (bytes, contentType) =>
    source.decoder === 'ktx2'
      ? { task: 'transcode-ktx2', input: { bytes, formats } }
      : { task: 'decode-image', input: { bytes, contentType } };
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

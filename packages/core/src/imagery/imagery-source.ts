// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { TileTransport, TileRequest, TimeoutsMs } from '../scheduler/types.js';
import type { TileCoord } from '../tiling/tile-key.js';
import type { TileRectangleRad, TilingScheme } from '../tiling/tiling-scheme.js';
import type { TileMask } from './coverage-area.js';
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
  /**
   * Optional: how many of the source's requests in flight wait for connectivity to return (`@vibeglobe/offline`
   * during an outage). They do not keep the engine busy, so it goes idle with the view as complete as it can be (KB-194).
   */
  heldRequests?(): number;
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
  /**
   * The tiles, cut on Web Mercator's grid, have rows linear in latitude: a WMS in EPSG:4326 asked for each Web Mercator
   * tile's extent, drawn without a warp and without the coarse ancestors a geographic tiling shows across its edges
   * (KB-232).
   */
  readonly latitudeRows?: boolean;
  /** How the bytes are decoded in the worker pool: browser image formats, or KTX2 (ADR 0020). */
  readonly decoder: 'image' | 'ktx2';
  /**
   * The outline of the source's area over a tile that crosses its border: the decoder makes the pixels outside it
   * transparent, so the layers below show there (F618, KB-209). Undefined for a tile wholly inside. Browser image
   * formats only; a source with masks is `transparent`.
   */
  tileMask?(coord: TileCoord): TileMask | undefined;
  /**
   * A color that, filling a whole tile, means the source has no data there (white or black filler a service sends
   * outside its area): such a tile counts as `noData` (F618). The fallback for services whose area is not known as a
   * polygon; browser image formats only.
   */
  readonly blankTile?: BlankTile;
}

/** A tile color that means "no data" (F618). */
export interface BlankTile {
  /** sRGB channels, 0–255. */
  readonly rgb: readonly [number, number, number];
  /** The largest difference per channel still counted as that color (default 2: JPEG noise). */
  readonly tolerance?: number;
}

/**
 * The worker task of an imagery source's tiles: KTX2 transcoded to the device's `formats` (ADR 0020), anything else
 * decoded as a browser image.
 */
export function imageryDecodeTask(
  source: ImagerySource,
  formats: readonly string[],
): (bytes: ArrayBuffer, contentType: string, coord?: TileCoord) => { task: string; input: unknown } {
  return (bytes, contentType, coord) => {
    if (source.decoder === 'ktx2') return { task: 'transcode-ktx2', input: { bytes, formats } };
    // Border tiles carry the area's outline and every tile the blank color, for the decoder (F618).
    const mask = coord && source.tileMask?.(coord);
    const blank = source.blankTile;
    return {
      task: 'decode-image',
      input: {
        bytes,
        contentType,
        ...(mask ? { mask } : {}),
        ...(blank ? { blank: { rgb: blank.rgb, tolerance: blank.tolerance ?? 2 } } : {}),
      },
    };
  };
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

const coveredExtent: TileRectangleRad = { westRad: 0, southRad: 0, eastRad: 0, northRad: 0 };
const coveredCoord: TileCoord = { root: 0, level: 0, x: 0, y: 0 };

/**
 * The tiles of a source at `level` within its coverage (all of them without one): their count, each one passed to
 * `visit` (F634). Used once per source, at start, not per frame.
 */
export function coveredTiles(source: TileSource, level: number, visit?: (x: number, y: number) => void): number {
  const { tiling, coverage } = source;
  const n = 2 ** level;
  let count = 0;
  coveredCoord.level = level;
  for (let y = 0; y < tiling.rootTilesY * n; y++)
    for (let x = 0; x < tiling.rootTilesX * n; x++) {
      if (coverage) {
        coveredCoord.x = x;
        coveredCoord.y = y;
        if (!inCoverage(coverage, tiling.tileExtent(coveredCoord, coveredExtent))) continue;
      }
      count++;
      visit?.(x, y);
    }
  return count;
}

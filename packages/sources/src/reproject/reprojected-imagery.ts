import { bleedTransparentEdges, encodeRgbaPng } from './edge-bleed.js';
import {
  GEOGRAPHIC_TILING,
  WEB_MERCATOR_TILING,
  type AbortHandle,
  type Attribution,
  type CreditProfile,
  type ImagerySource,
  type TileCoord,
  type TileRectangleRad,
  type TileRequest,
  type TileTransport,
  type TimeoutsMs,
  type TransportResult,
} from '@vibeglobe/core';
import { tileOfUrl } from '../archive-transport.js';
import { fetchTransport } from '../fetch-transport.js';
import { inLevelsAndCoverage } from '../tiling.js';
import {
  lonLatBoundsOf,
  planWarp,
  type FromSource,
  type SourceBbox,
  type ToSource,
  type WarpPlan,
} from './warp-math.js';

/** Draws a fetched source image into a tile as the plan says and encodes the tile (PNG bytes). */
export type WarpImage = (bytes: ArrayBuffer, contentType: string, plan: WarpPlan) => Promise<ArrayBuffer>;

/** Options of {@link reprojectedImagery}. */
export interface ReprojectedImageryOptions {
  /** Unique per engine instance. */
  readonly id: string;
  /** The source's reference system, such as 'EPSG:32632' (informative: the functions below do the work). */
  readonly sourceCrs: string;
  /** WGS84 longitude and latitude (degrees) to source coordinates, e.g. from `transformCoordinates` of `@vibeglobe/gis`. */
  readonly toSource: ToSource;
  /** Source coordinates to WGS84 longitude and latitude (degrees). */
  readonly fromSource: FromSource;
  /** Where the source has data, in source units: west, south, east, north. */
  readonly bounds: SourceBbox;
  /** The URL of a source image covering `bbox` (source units) at a pixel size, such as {@link wmsGetMapUrl}'s. */
  readonly image: (bbox: SourceBbox, widthPx: number, heightPx: number) => string;
  /** Target tiling: Web Mercator XYZ (default) or the two-root geographic pyramid. */
  readonly tiling?: 'mercator' | 'geographic';
  readonly minLevel?: number;
  readonly maxLevel?: number;
  /** Tile edge, pixels (default 256). */
  readonly tileSizePx?: number;
  /** The largest source image side requested, pixels (default twice the tile size). */
  readonly maxImagePx?: number;
  /** Cells per tile side of the piecewise-affine warp (default 16). */
  readonly gridCells?: number;
  /** Credits shown while the source's tiles are in view (F254). */
  readonly attribution?: readonly Attribution[];
  readonly profile?: CreditProfile;
  /** The transport of the source images; `fetchTransport()` by default. */
  readonly transport?: TileTransport;
  /** Replaces the browser warp (tests, other runtimes). */
  readonly warpImage?: WarpImage;
  readonly maxRequestsPerHost?: number;
  readonly timeoutsMs?: TimeoutsMs;
}

/**
 * Warps in the browser: the source image is decoded by `createImageBitmap` and drawn once per triangle of the plan,
 * clipped to the triangle under the triangle's affine map, into an `OffscreenCanvas`. Pixels the source image does
 * not cover stay transparent, with their visible neighbors' color so that no dark edge shows (`bleedTransparentEdges`).
 */
export const warpInBrowser: WarpImage = async (bytes, contentType, plan) => {
  const bitmap = await createImageBitmap(new Blob([bytes], { type: contentType }));
  try {
    const canvas = new OffscreenCanvas(plan.tileSizePx, plan.tileSizePx);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('no 2D context');
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    for (const { clipPx: c, transform: m } of plan.triangles) {
      context.save();
      context.beginPath();
      context.moveTo(c[0], c[1]);
      context.lineTo(c[2], c[3]);
      context.lineTo(c[4], c[5]);
      context.closePath();
      context.clip();
      context.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
      context.drawImage(bitmap, 0, 0, plan.imageWidthPx, plan.imageHeightPx);
      context.restore();
    }
    const pixels = context.getImageData(0, 0, plan.tileSizePx, plan.tileSizePx).data;
    bleedTransparentEdges(pixels, plan.tileSizePx, plan.tileSizePx);
    return await encodeRgbaPng(pixels, plan.tileSizePx, plan.tileSizePx);
  } finally {
    bitmap.close();
  }
};

/** The transport of a reprojected source: one source image per tile, warped into the tile. */
function reprojectTransport(
  plan: (coord: TileCoord) => WarpPlan | undefined,
  image: ReprojectedImageryOptions['image'],
  base: TileTransport,
  warp: WarpImage,
): TileTransport {
  return {
    start(request: TileRequest, timeouts: TimeoutsMs, done: (result: TransportResult) => void): AbortHandle {
      let settled = false;
      const finish = (result: TransportResult): void => {
        if (settled) return;
        settled = true;
        done(result);
      };
      const tile = tileOfUrl(request.url);
      const warpPlan = tile ? plan({ root: 0, level: tile.z, x: tile.x, y: tile.y }) : undefined;
      if (!warpPlan) {
        finish({ kind: 'status', status: 404, retryAfterMs: undefined });
        return () => undefined;
      }
      const url = image(warpPlan.imageBbox, warpPlan.imageWidthPx, warpPlan.imageHeightPx);
      const abortBase = base.start({ url, hostIndex: 0 }, timeouts, (result) => {
        if (result.kind !== 'ok') return finish(result);
        // A WMS service exception: a permanent failure, so the tile is not asked again and its parent stays.
        if (/xml/i.test(result.contentType)) return finish({ kind: 'status', status: 400, retryAfterMs: undefined });
        if (result.bytes.byteLength === 0) return finish(result);
        warp(result.bytes, result.contentType, warpPlan).then(
          (bytes) => finish({ kind: 'ok', bytes, contentType: 'image/png' }),
          // An image that cannot be decoded is no data, never a crash.
          () => finish({ kind: 'ok', bytes: new ArrayBuffer(0), contentType: '' }),
        );
      });
      return () => {
        if (settled) return;
        abortBase();
        finish({ kind: 'aborted' });
      };
    },
  };
}

/**
 * Imagery in another reference system (UTM, national grids, …) reprojected on the client into Web Mercator or
 * geographic tiles (F226): for each tile one source image covering the tile's footprint is fetched (a GetMap in the
 * source system, {@link wmsGetMapUrl}) and warped piecewise-affinely (a 16 × 16 grid of triangle pairs) with
 * `toSource`. Tiles outside `bounds` or the levels are never requested.
 */
export function reprojectedImagery(options: ReprojectedImageryOptions): ImagerySource {
  const tilingName = options.tiling ?? 'mercator';
  const tiling = tilingName === 'geographic' ? GEOGRAPHIC_TILING : WEB_MERCATOR_TILING;
  const tileSizePx = options.tileSizePx ?? 256;
  const coverage = [lonLatBoundsOf(options.bounds, options.fromSource)];
  const prefix = `reproject:${encodeURIComponent(options.id)}/`;
  const extent: TileRectangleRad = { westRad: 0, southRad: 0, eastRad: 0, northRad: 0 };
  const source: ImagerySource = {
    id: options.id,
    tiling,
    minLevel: options.minLevel ?? 0,
    maxLevel: options.maxLevel ?? 19,
    tileSizePx,
    pixelRatio: 1,
    // Outside the data the warped tiles are transparent: the layers below show there (F242).
    transparent: true,
    coverage,
    decoder: 'image',
    transport: reprojectTransport(
      (coord) =>
        planWarp({
          extent: tiling.tileExtent(coord, { westRad: 0, southRad: 0, eastRad: 0, northRad: 0 }),
          tiling: tilingName,
          tileSizePx,
          toSource: options.toSource,
          bounds: options.bounds,
          ...(options.gridCells === undefined ? {} : { gridCells: options.gridCells }),
          ...(options.maxImagePx === undefined ? {} : { maxImagePx: options.maxImagePx }),
        }),
      options.image,
      options.transport ?? fetchTransport(),
      options.warpImage ?? warpInBrowser,
    ),
    ...(options.maxRequestsPerHost === undefined ? {} : { maxRequestsPerHost: options.maxRequestsPerHost }),
    ...(options.timeoutsMs === undefined ? {} : { timeoutsMs: options.timeoutsMs }),
    ...(options.attribution ? { attribution: options.attribution } : {}),
    ...(options.profile ? { profile: options.profile } : {}),
    request(coord: TileCoord, out: TileRequest): TileRequest | 'noData' {
      if (!inLevelsAndCoverage(source, coord, extent)) return 'noData';
      out.url = `${prefix}${coord.level}/${coord.x}/${coord.y}`;
      out.hostIndex = 0;
      return out;
    },
  };
  return source;
}

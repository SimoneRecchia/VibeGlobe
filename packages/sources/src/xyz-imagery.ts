import {
  GEOGRAPHIC_TILING,
  inCoverage,
  WEB_MERCATOR_TILING,
  type ImagerySource,
  type TileCoord,
  type TileRectangleRad,
  type TileRequest,
  type TileTransport,
} from '@vibeglobe/core';
import { fetchTransport } from './fetch-transport.js';

/** Options of {@link xyzImagery}. */
export interface XyzImageryOptions {
  /** Unique per engine instance. */
  id: string;
  /**
   * URL template with `{z}`, `{x}` and `{y}`, `{-y}` for TMS rows counted from the south, and `{s}` for a host from
   * `subdomains`.
   */
  url: string;
  /** Tiling scheme: Web Mercator XYZ (default) or the two-root geographic pyramid. */
  tiling?: 'mercator' | 'geographic';
  minLevel?: number;
  maxLevel?: number;
  tileSizePx?: number;
  /** 2 for high-DPI (`@2x`) tiles. */
  pixelRatio?: number;
  /** Values for `{s}`, spread over tiles so several hosts share the load (F089). */
  subdomains?: readonly string[];
  /** The areas with data, radians; tiles outside are never requested (F094). */
  coverage?: readonly TileRectangleRad[];
  decoder?: 'image' | 'ktx2';
  /** The network transport; `fetchTransport()` by default. */
  transport?: TileTransport;
}

/** A tiled imagery source from an XYZ or TMS URL template. */
export function xyzImagery(options: XyzImageryOptions): ImagerySource {
  const tiling = options.tiling === 'geographic' ? GEOGRAPHIC_TILING : WEB_MERCATOR_TILING;
  const minLevel = options.minLevel ?? 0;
  const maxLevel = options.maxLevel ?? 19;
  const subdomains = options.subdomains ?? [];
  const extent: TileRectangleRad = { westRad: 0, southRad: 0, eastRad: 0, northRad: 0 };
  return {
    id: options.id,
    tiling,
    minLevel,
    maxLevel,
    tileSizePx: options.tileSizePx ?? 256,
    pixelRatio: options.pixelRatio ?? 1,
    ...(options.coverage ? { coverage: options.coverage } : {}),
    transport: options.transport ?? fetchTransport(),
    decoder: options.decoder ?? 'image',
    request(coord: TileCoord, out: TileRequest): TileRequest | 'noData' {
      if (coord.level < minLevel || coord.level > maxLevel) return 'noData';
      if (options.coverage && !inCoverage(options.coverage, tiling.tileExtent(coord, extent))) return 'noData';
      const rows = tiling.rootTilesY * 2 ** coord.level;
      const hostIndex = subdomains.length > 0 ? (coord.x + coord.y) % subdomains.length : 0;
      out.url = options.url
        .replace('{z}', String(coord.level))
        .replace('{x}', String(coord.x))
        .replace('{-y}', String(rows - 1 - coord.y))
        .replace('{y}', String(coord.y))
        .replace('{s}', subdomains[hostIndex] ?? '');
      out.hostIndex = hostIndex;
      return out;
    },
  };
}

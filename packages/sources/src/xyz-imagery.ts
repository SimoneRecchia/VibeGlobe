// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import {
  type CoverageArea,
  type GeoJsonArea,
  GEOGRAPHIC_TILING,
  inCoverage,
  WEB_MERCATOR_TILING,
  type ImagerySource,
  type TileCoord,
  type TileRectangleRad,
  type TileRequest,
  type TileTransport,
  type TimeoutsMs,
  type Attribution,
  type CreditProfile,
} from '@vibeglobe/core';
import { sourceArea } from './clip-area.js';
import { fetchTransport } from './fetch-transport.js';
import { SourceConfigError } from './metadata.js';

/** Options of {@link xyzImagery}. */
export interface XyzImageryOptions {
  /** Unique per engine instance. */
  id: string;
  /**
   * URL template with `{z}`, `{x}` and `{y}`, `{-y}` for TMS rows counted from the south, `{s}` for a host from
   * `subdomains`, and `{r}`, which becomes `@2x` on high-DPI canvases and nothing elsewhere (F241).
   */
  url: string;
  /** Tiling scheme: Web Mercator XYZ (default) or the two-root geographic pyramid. */
  tiling?: 'mercator' | 'geographic';
  minLevel?: number;
  maxLevel?: number;
  tileSizePx?: number;
  /** The tiles have transparent areas, where the layers below show (F242). */
  transparent?: boolean;
  /** 2 for high-DPI (`@2x`) tiles. */
  pixelRatio?: number;
  /** Headers sent with every tile request by the default transport (F229); a custom `transport` sets its own. */
  headers?: Readonly<Record<string, string>>;
  /** Values for `{s}`, spread over tiles so several hosts share the load (F089). */
  subdomains?: readonly string[];
  /** The areas with data, radians; tiles outside are never requested (F094). */
  coverage?: readonly TileRectangleRad[];
  /**
   * Polygons the source has data for (land, a country's borders), as an area or as GeoJSON (a Polygon, MultiPolygon,
   * Feature or FeatureCollection): tiles outside them are never requested, so the next source of the layer, or the
   * layer below, is drawn there. GeoJSON and `tiles: 'clip'` also request the tiles across the border and make their
   * pixels outside the area transparent, so the layer below shows there instead of the service's filler (F618,
   * KB-209); such a source is `transparent`. An area without `tiles` requests only tiles wholly inside.
   */
  area?: CoverageArea | GeoJsonArea;
  /**
   * A color (`#rrggbb` or `[r, g, b]`) that, filling a whole tile, means no data, for services that answer outside
   * their area with blank tiles instead of a 404 and whose area is not known as a polygon (F618). Tiles that are only
   * partly blank still show it: prefer `area`.
   */
  blankTile?: string | readonly [number, number, number];
  /**
   * The share of a tile's pixels that must be the `blankTile` color, in (0, 1] (default 1): below 1, a filler with a
   * caption, such as Esri's "Map data not yet available", is no data too, and the level above shows magnified (F691).
   */
  blankShare?: number;
  decoder?: 'image' | 'ktx2';
  /** The network transport; `fetchTransport()` by default. */
  transport?: TileTransport;
  /** Requests in flight to each host (default 6, or 16 with `multiplexed`, ADR 0007; F089). */
  maxRequestsPerHost?: number;
  /** The hosts speak HTTP/2 or HTTP/3, so more requests share one connection (F096). */
  multiplexed?: boolean;
  /** Requests per second the hosts accept; the engine never starts more in any second (F222). */
  maxRequestsPerSecond?: number;
  /** Time limits of each request (default 10 s to the headers, 30 s in all; F092). */
  timeoutsMs?: TimeoutsMs;
  /** Credits shown while the source's tiles are in view (F254). */
  attribution?: readonly Attribution[];
  /** The provider's credit rules: a required credit is always shown (F255). */
  profile?: CreditProfile;
}

/** The fields a URL template may hold. */
const TEMPLATE_FIELDS = new Set(['z', 'x', 'y', '-y', 's', 'r']);

/**
 * Checks a URL template (F229): every `{…}` is a known field, braces pair up, `{z}`, `{x}` and `{y}` or `{-y}` appear,
 * and `{s}` comes with subdomains. Throws a `SourceConfigError` that names the problem.
 */
function checkUrlTemplate(url: string, subdomains: readonly string[]): void {
  const fail = (problem: string): never => {
    throw new SourceConfigError('invalid-url-template', `The URL template ${JSON.stringify(url)} ${problem}.`);
  };
  const fields = [...url.matchAll(/\{([^{}]*)\}/g)].map((match) => match[1] ?? '');
  if (/[{}]/.test(url.replace(/\{[^{}]*\}/g, ''))) fail('has an unpaired brace');
  for (const field of fields) if (!TEMPLATE_FIELDS.has(field)) fail(`has an unknown field {${field}}`);
  for (const field of ['z', 'x']) if (!fields.includes(field)) fail(`must contain {${field}}`);
  if (!fields.includes('y') && !fields.includes('-y')) fail('must contain {y} (rows from the north) or {-y} (TMS)');
  if (fields.includes('s') && subdomains.length === 0) fail('uses {s} without subdomains');
}

/** The `blankTile` option as channels; a malformed color throws a `SourceConfigError`. */
function blankColor(color: XyzImageryOptions['blankTile']): readonly [number, number, number] | undefined {
  if (color === undefined) return undefined;
  if (typeof color !== 'string') return color;
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  if (!match)
    throw new SourceConfigError('invalid-option', `blankTile ${JSON.stringify(color)} is not a #rrggbb color.`);
  return [parseInt(match[1] ?? '0', 16), parseInt(match[2] ?? '0', 16), parseInt(match[3] ?? '0', 16)];
}

/** A tiled imagery source from an XYZ or TMS URL template; an invalid template throws a `SourceConfigError`. */
export function xyzImagery(options: XyzImageryOptions): ImagerySource {
  checkUrlTemplate(options.url, options.subdomains ?? []);
  const tiling = options.tiling === 'geographic' ? GEOGRAPHIC_TILING : WEB_MERCATOR_TILING;
  const minLevel = options.minLevel ?? 0;
  const maxLevel = options.maxLevel ?? 19;
  const subdomains = options.subdomains ?? [];
  const extent: TileRectangleRad = { westRad: 0, southRad: 0, eastRad: 0, northRad: 0 };
  const area = sourceArea(options.area, tiling, options.tileSizePx ?? 256);
  const blank = blankColor(options.blankTile);
  const share = options.blankShare;
  if (share !== undefined && !(share > 0 && share <= 1))
    throw new SourceConfigError('invalid-option', `blankShare ${String(share)} is not in (0, 1].`);
  return {
    id: options.id,
    tiling,
    minLevel,
    maxLevel,
    tileSizePx: options.tileSizePx ?? 256,
    pixelRatio: options.pixelRatio ?? 1,
    // The area's bounding rectangles let the engine skip whole regions before asking for tiles.
    ...(options.coverage || area ? { coverage: options.coverage ?? area?.test.rectangles ?? [] } : {}),
    transport: options.transport ?? fetchTransport(undefined, options.headers),
    // A custom transport (auth headers, sessions) is the only way to reach the tiles: a cache tier in front of the
    // source must use it rather than fetch the URLs itself (track B hook request 4, TB-01).
    ...(options.transport || options.headers ? { transportRequired: true } : {}),
    ...(options.transport || options.headers ? { authenticated: true } : {}),
    decoder: options.decoder ?? 'image',
    ...(options.maxRequestsPerHost === undefined ? {} : { maxRequestsPerHost: options.maxRequestsPerHost }),
    ...(options.multiplexed === undefined ? {} : { multiplexed: options.multiplexed }),
    ...(options.maxRequestsPerSecond === undefined ? {} : { maxRequestsPerSecond: options.maxRequestsPerSecond }),
    ...(options.timeoutsMs === undefined ? {} : { timeoutsMs: options.timeoutsMs }),
    ...(options.attribution ? { attribution: options.attribution } : {}),
    ...(options.transparent || area?.clip ? { transparent: true } : {}),
    ...(area?.tileMask ? { tileMask: area.tileMask } : {}),
    ...(blank ? { blankTile: { rgb: blank, ...(share === undefined ? {} : { share }) } } : {}),
    ...(options.profile ? { profile: options.profile } : {}),
    ...(options.url.includes('{r}') ? { highDpi: true } : {}),
    request(coord: TileCoord, out: TileRequest, pixelRatio = 1): TileRequest | 'noData' {
      if (coord.level < minLevel || coord.level > maxLevel) return 'noData';
      if (options.coverage && !inCoverage(options.coverage, tiling.tileExtent(coord, extent))) return 'noData';
      if (area && !area.test.covers(tiling.tileExtent(coord, extent))) return 'noData';
      const rows = tiling.rootTilesY * 2 ** coord.level;
      const hostIndex = subdomains.length > 0 ? (coord.x + coord.y) % subdomains.length : 0;
      out.url = options.url
        .replaceAll('{z}', String(coord.level))
        .replaceAll('{x}', String(coord.x))
        .replaceAll('{-y}', String(rows - 1 - coord.y))
        .replaceAll('{y}', String(coord.y))
        .replaceAll('{s}', subdomains[hostIndex] ?? '')
        .replaceAll('{r}', pixelRatio > 1 ? '@2x' : '');
      out.hostIndex = hostIndex;
      return out;
    },
  };
}

import {
  GEOGRAPHIC_TILING,
  WEB_MERCATOR_TILING,
  type TileCoord,
  type TileRectangleRad,
  type TileRequest,
  type TileTransport,
} from '@vibeglobe/core';
import { fetchTransport } from '../fetch-transport.js';
import {
  type Attribution,
  CUSTOM_PROFILE,
  type DescribedImagerySource,
  type ProviderProfile,
  SourceConfigError,
} from '../metadata.js';
import { coverageOf, inLevelsAndCoverage } from '../tiling.js';
import { MERCATOR_HALF_WORLD_M, normalizeCrs, tilingOfCrs } from './crs.js';
import { loadCapabilities } from './load.js';
import { parseWmsCapabilities, type WmsCapabilities } from './wms-capabilities.js';
import { reprojectedImagery } from '../reproject/reprojected-imagery.js';
import { wmsGetMapUrl } from '../reproject/wms-get-map.js';
import { sourceBoundsOf, type FromSource, type ToSource } from '../reproject/warp-math.js';
import { type CropImage, cropInBrowser, wmsTransport } from './wms-transport.js';

/** Options of {@link wmsImagery}. */
export interface WmsImageryOptions {
  /** Unique per engine instance. */
  readonly id: string;
  /** The GetMap endpoint; taken from the capabilities when omitted. */
  readonly url?: string;
  /** The GetCapabilities document (URL or XML text): version, reference systems, bounds and attribution. */
  readonly capabilities?: string;
  /** '1.3.0' (default) or '1.1.1'; the capabilities' version when given. */
  readonly version?: '1.1.1' | '1.3.0';
  /** Layer names, drawn bottom first. */
  readonly layers: readonly string[];
  /** One style per layer; the defaults when omitted. */
  readonly styles?: readonly string[];
  /** Image format (default `image/png`). */
  readonly format?: string;
  /** Asks for a transparent background (default true), so the layers below show through. */
  readonly transparent?: boolean;
  /** 'EPSG:3857' (default) or 'EPSG:4326': requested directly when the service offers it (F227). */
  readonly preferredCrs?: 'EPSG:3857' | 'EPSG:4326';
  /**
   * Transforms for other reference systems, such as `transformCoordinates` of `@vibeglobe/gis` (F227): when the layers
   * offer neither EPSG:3857 nor EPSG:4326, the first offered system this returns transforms for is requested and
   * reprojected on the client (ADR 0039). Without it, such a service is refused with a `needs-reprojection` error.
   */
  readonly transforms?: (crs: string) => { readonly toSource: ToSource; readonly fromSource: FromSource } | undefined;
  readonly maxLevel?: number;
  readonly tileSizePx?: number;
  /**
   * Pixels requested beyond each tile edge and cropped away, so labels near an edge are drawn whole on both tiles
   * (default 32; 0 turns it off). Cropping needs `createImageBitmap` and `OffscreenCanvas`, or `cropImage`.
   */
  readonly gutterPx?: number;
  /** Replaces the browser crop (tests, other runtimes). */
  readonly cropImage?: CropImage;
  /** Extra query parameters (vendor parameters, `TIME`, …). */
  readonly parameters?: Readonly<Record<string, string>>;
  readonly attribution?: readonly Attribution[];
  readonly profile?: ProviderProfile;
  readonly transport?: TileTransport;
  /** The `fetch` that loads the capabilities document. */
  readonly fetch?: typeof fetch;
  readonly maxRequestsPerHost?: number;
}

/** The reference system to request: the preferred one when offered, else the other one the engine draws directly. */
function chooseCrs(options: WmsImageryOptions, capabilities: WmsCapabilities | undefined): string {
  const offered = capabilities
    ? options.layers.map((name) => capabilities.layers.find((l) => l.name === name)?.crs ?? [])
    : [['EPSG:3857', 'EPSG:4326']];
  const everywhere = (crs: string): boolean => offered.every((list) => list.includes(crs));
  const order =
    options.preferredCrs === 'EPSG:4326' ? ['EPSG:4326', 'CRS:84', 'EPSG:3857'] : ['EPSG:3857', 'EPSG:4326', 'CRS:84'];
  const chosen = order.find(everywhere);
  if (!chosen)
    throw new SourceConfigError(
      'needs-reprojection',
      `WMS source '${options.id}': the layers offer neither EPSG:3857 nor EPSG:4326 (offered: ${[...new Set(offered.flat())].join(', ')}); ` +
        'they need client-side reprojection',
    );
  return chosen;
}

/**
 * The client-side reprojection of a service whose layers offer neither EPSG:3857 nor EPSG:4326, through the first
 * offered system the application's `transforms` know (F227, ADR 0039); undefined when a directly drawable system is
 * offered or no transforms are given.
 */
function reprojectedFallback(
  options: WmsImageryOptions,
  capabilities: WmsCapabilities | undefined,
  url: string,
): DescribedImagerySource | undefined {
  if (!capabilities || !options.transforms) return undefined;
  const offered = options.layers.map((name) => capabilities.layers.find((l) => l.name === name)?.crs ?? []);
  const shared = (offered[0] ?? []).filter((crs) => offered.every((list) => list.includes(crs)));
  if (shared.some((crs) => tilingOfCrs(crs) !== undefined)) return undefined;
  for (const crs of shared) {
    const transforms = options.transforms(crs);
    const lonLat = options.layers
      .map((n) => capabilities.layers.find((l) => l.name === n)?.bounds)
      .find((b) => b !== undefined);
    if (!transforms || !lonLat) continue;
    const code = requestCode(crs, options, capabilities);
    const source = reprojectedImagery({
      id: options.id,
      sourceCrs: crs,
      toSource: transforms.toSource,
      fromSource: transforms.fromSource,
      bounds: sourceBoundsOf(lonLat, transforms.toSource),
      image: (bbox, widthPx, heightPx) =>
        wmsGetMapUrl(url, {
          layers: options.layers,
          crs: code,
          bbox,
          widthPx,
          heightPx,
          ...(options.format ? { format: options.format } : {}),
          ...(options.styles ? { styles: options.styles } : {}),
          ...(options.transparent === undefined ? {} : { transparent: options.transparent }),
        }),
      maxLevel: options.maxLevel ?? 20,
      ...(options.transport ? { transport: options.transport } : {}),
      ...(options.maxRequestsPerHost === undefined ? {} : { maxRequestsPerHost: options.maxRequestsPerHost }),
      attribution: attributionOf(options, capabilities),
      profile: options.profile ?? CUSTOM_PROFILE,
    });
    return source as DescribedImagerySource;
  }
  return undefined;
}

/**
 * The code to send for `crs`: the one the layers advertise when they write it differently (`EPSG:900913` for Web
 * Mercator), so a server that knows only its own alias accepts the request.
 */
function requestCode(crs: string, options: WmsImageryOptions, capabilities: WmsCapabilities | undefined): string {
  const lists = options.layers.map(
    (name) =>
      capabilities?.layers.find((l) => l.name === name)?.advertisedCrs.filter((code) => normalizeCrs(code) === crs) ??
      [],
  );
  const shared = (lists[0] ?? []).filter((code) => lists.every((list) => list.includes(code)));
  if (shared.length === 0 || shared.includes(crs)) return crs;
  return shared[0] ?? crs;
}

function checkLayers(options: WmsImageryOptions, capabilities: WmsCapabilities | undefined): void {
  if (options.layers.length === 0)
    throw new SourceConfigError('no-layers', `WMS source '${options.id}': no layer named`);
  const missing = options.layers.filter((name) => capabilities && !capabilities.layers.some((l) => l.name === name));
  if (missing.length > 0)
    throw new SourceConfigError('unknown-layer', `WMS source '${options.id}': unknown layers ${missing.join(', ')}`);
}

/** Writes the BBOX of a tile, widened by the gutter, in the axis order of the version and reference system. */
function bboxWriter(crs: string, version: string, gutterRatio: number): (extent: TileRectangleRad) => string {
  const DEG = 180 / Math.PI;
  const latitudeFirst = version === '1.3.0' && crs === 'EPSG:4326';
  return (e) => {
    let [w, s, east, n] = [e.westRad * DEG, e.southRad * DEG, e.eastRad * DEG, e.northRad * DEG];
    if (crs === 'EPSG:3857') {
      const y = (latDeg: number): number =>
        MERCATOR_HALF_WORLD_M * (Math.log(Math.tan(Math.PI / 4 + latDeg / DEG / 2)) / Math.PI);
      [w, s, east, n] = [(w / 180) * MERCATOR_HALF_WORLD_M, y(s), (east / 180) * MERCATOR_HALF_WORLD_M, y(n)];
    }
    const dx = (east - w) * gutterRatio;
    const dy = (n - s) * gutterRatio;
    const box = latitudeFirst ? [s - dy, w - dx, n + dy, east + dx] : [w - dx, s - dy, east + dx, n + dy];
    return box.map((v) => Number(v.toFixed(crs === 'EPSG:3857' ? 4 : 10))).join(',');
  };
}

function attributionOf(options: WmsImageryOptions, capabilities: WmsCapabilities | undefined): Attribution[] {
  if (options.attribution) return [...options.attribution];
  const found = options.layers.flatMap((name) => {
    const credit = capabilities?.layers.find((l) => l.name === name)?.attribution;
    return credit ? [credit] : [];
  });
  return found.filter((a, i) => found.findIndex((b) => b.text === a.text) === i);
}

/**
 * A WMS imagery source (F231): one GetMap image per tile in WMS 1.1.1 or 1.3.0 (with 1.3.0's latitude-first axis order
 * for EPSG:4326), transparent by default, with a gutter cropped away so labels are not cut at tile edges. It requests
 * EPSG:3857 or EPSG:4326 directly when the layers offer it (F227); other reference systems need client-side
 * reprojection, which the engine's layer composition provides (F226).
 */
export async function wmsImagery(options: WmsImageryOptions): Promise<DescribedImagerySource> {
  const capabilities = options.capabilities
    ? await loadCapabilities(options.capabilities, options.fetch, options.id, 'WMS', parseWmsCapabilities)
    : undefined;
  checkLayers(options, capabilities);
  const url = options.url ?? capabilities?.getMapUrl;
  if (!url) throw new SourceConfigError('no-getmap-url', `WMS source '${options.id}': no GetMap URL`);
  const version = capabilities?.version ?? options.version ?? '1.3.0';
  const reprojected = reprojectedFallback(options, capabilities, url);
  if (reprojected) return reprojected;
  const crs = chooseCrs(options, capabilities);
  const sizePx = options.tileSizePx ?? 256;
  const gutterPx = options.gutterPx ?? 32;
  const separator = url.includes('?') ? (/[?&]$/.test(url) ? '' : '&') : '?';
  const extra = Object.entries(options.parameters ?? {}).map(
    ([k, v]) => `&${encodeURIComponent(k)}=${encodeURIComponent(v)}`,
  );
  const prefix =
    `${url}${separator}SERVICE=WMS&REQUEST=GetMap&VERSION=${version}&LAYERS=${options.layers.map(encodeURIComponent).join(',')}` +
    `&STYLES=${(options.styles ?? options.layers.map(() => '')).map(encodeURIComponent).join(',')}` +
    `&FORMAT=${encodeURIComponent(options.format ?? 'image/png')}&TRANSPARENT=${options.transparent === false ? 'FALSE' : 'TRUE'}` +
    `&${version === '1.3.0' ? 'CRS' : 'SRS'}=${encodeURIComponent(requestCode(crs, options, capabilities))}` +
    `&WIDTH=${sizePx + 2 * gutterPx}&HEIGHT=${sizePx + 2 * gutterPx}${extra.join('')}&BBOX=`;
  const bbox = bboxWriter(crs, version, gutterPx / sizePx);
  const bounds = options.layers
    .map((n) => capabilities?.layers.find((l) => l.name === n)?.bounds)
    .find((b) => b !== undefined);
  const coverage = bounds ? coverageOf(...bounds) : undefined;
  const extent: TileRectangleRad = { westRad: 0, southRad: 0, eastRad: 0, northRad: 0 };
  const source: DescribedImagerySource = {
    id: options.id,
    tiling: tilingOfCrs(crs) === 'mercator' ? WEB_MERCATOR_TILING : GEOGRAPHIC_TILING,
    minLevel: 0,
    maxLevel: options.maxLevel ?? 20,
    tileSizePx: sizePx,
    pixelRatio: 1,
    ...(coverage ? { coverage: [coverage] } : {}),
    decoder: 'image',
    // The layers below show through what the server leaves transparent (KB-154).
    transparent: options.transparent !== false,
    transportRequired: true,
    transport: wmsTransport(
      options.transport ?? fetchTransport(),
      gutterPx,
      sizePx,
      options.cropImage ?? cropInBrowser,
    ),
    ...(options.maxRequestsPerHost === undefined ? {} : { maxRequestsPerHost: options.maxRequestsPerHost }),
    attribution: attributionOf(options, capabilities),
    profile: options.profile ?? CUSTOM_PROFILE,
    request(coord: TileCoord, out: TileRequest): TileRequest | 'noData' {
      if (!inLevelsAndCoverage(source, coord, extent)) return 'noData';
      out.url = prefix + bbox(source.tiling.tileExtent(coord, extent));
      out.hostIndex = 0;
      return out;
    },
  };
  return source;
}

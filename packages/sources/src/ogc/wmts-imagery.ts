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
import { loadCapabilities } from './load.js';
import { matchMatrixSet, type MatchedMatrixSet } from './tile-matrix.js';
import { parseWmtsCapabilities, type WmtsCapabilities, type WmtsLayer } from './wmts-capabilities.js';
import { matrixBounds, wmtsParts } from './wmts-reprojected.js';
import { reprojectedImagery } from '../reproject/reprojected-imagery.js';
import { sourceBoundsOf, type FromSource, type SourceBbox, type ToSource } from '../reproject/warp-math.js';

/** Options of {@link wmtsImagery}. */
export interface WmtsImageryOptions {
  /** Unique per engine instance. */
  readonly id: string;
  /** The GetCapabilities document: its URL, or its XML text. */
  readonly capabilities: string;
  /** The layer identifier. */
  readonly layer: string;
  /** Style identifier; the layer's default style when omitted. */
  readonly style?: string;
  /** Image format (MIME type); PNG, then JPEG, then WebP, then the first offered when omitted. */
  readonly format?: string;
  /** Tile matrix set identifier; the first that lines up with the preferred reference system when omitted. */
  readonly tileMatrixSet?: string;
  /** 'EPSG:3857' (default) or 'EPSG:4326': requested directly when the service offers it (F227). */
  readonly preferredCrs?: 'EPSG:3857' | 'EPSG:4326';
  /**
   * Transforms for other reference systems, such as `transformCoordinates` of `@vibeglobe/gis` (F227): when no tile
   * matrix set lines up with EPSG:3857 or EPSG:4326, the first projected set this returns transforms for is
   * reprojected on the client, its tiles composed per engine tile (ADR 0039). Without it such a layer is refused.
   */
  readonly transforms?: (crs: string) => { readonly toSource: ToSource; readonly fromSource: FromSource } | undefined;
  /** Dimension values (for example `{ Time: '2024-01-01' }`); each dimension's default otherwise. */
  readonly dimensions?: Readonly<Record<string, string>>;
  /** 'RESTful' or 'KVP'; RESTful when the layer has a tile resource URL, else KVP. */
  readonly encoding?: 'RESTful' | 'KVP';
  /** Replaces the attribution derived from the service provider. */
  readonly attribution?: readonly Attribution[];
  readonly profile?: ProviderProfile;
  /** The transport of tile requests; `fetchTransport()` by default. */
  readonly transport?: TileTransport;
  /** The `fetch` that loads the capabilities document. */
  readonly fetch?: typeof fetch;
  readonly maxRequestsPerHost?: number;
}

const PREFERRED_FORMATS = ['image/png', 'image/jpeg', 'image/webp'];

function chooseFormat(layer: WmtsLayer, wanted: string | undefined): string {
  const offered = [...layer.formats, ...layer.resourceUrls.map((r) => r.format)];
  if (wanted !== undefined) return wanted;
  return PREFERRED_FORMATS.find((f) => offered.includes(f)) ?? offered[0] ?? 'image/png';
}

/** The tile matrix set to use: the requested one, else the first that lines up with the preferred scheme. */
function chooseSet(
  capabilities: WmtsCapabilities,
  layer: WmtsLayer,
  options: WmtsImageryOptions,
): { identifier: string; matched: MatchedMatrixSet; limits: WmtsLayer['tileMatrixSetLinks'][number]['limits'] } {
  const links = layer.tileMatrixSetLinks.filter(
    (l) => options.tileMatrixSet === undefined || l.set === options.tileMatrixSet,
  );
  const candidates = links.flatMap((link) => {
    const set = capabilities.tileMatrixSets.find((s) => s.identifier === link.set);
    const matched = set ? matchMatrixSet(set) : undefined;
    return matched ? [{ identifier: link.set, matched, limits: link.limits }] : [];
  });
  const preferred = options.preferredCrs === 'EPSG:4326' ? 'geographic' : 'mercator';
  // The preferred scheme first, then the set with the most levels (ArcGIS offers a partial 0.28 mm set first).
  candidates.sort(
    (a, b) =>
      Number(b.matched.tiling === preferred) - Number(a.matched.tiling === preferred) ||
      b.matched.levels.size - a.matched.levels.size,
  );
  const chosen = candidates[0];
  if (!chosen) {
    const offered = links.map(
      (l) => `${l.set} (${capabilities.tileMatrixSets.find((s) => s.identifier === l.set)?.crs ?? '?'})`,
    );
    throw new SourceConfigError(
      'needs-reprojection',
      `WMTS source '${options.id}': no tile matrix set of layer '${layer.identifier}' lines up with EPSG:3857 or ` +
        `EPSG:4326 (offered: ${offered.join(', ') || 'none'}); it needs client-side reprojection`,
    );
  }
  return chosen;
}

function fill(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{([^}]+)\}/g, (whole, name: string) => {
    const key = Object.keys(values).find((k) => k.toLowerCase() === name.toLowerCase());
    return key === undefined ? whole : encodeURIComponent(values[key] ?? '');
  });
}

/** Builds the tile URL function for the chosen encoding. */
function urlBuilder(
  capabilities: WmtsCapabilities,
  layer: WmtsLayer,
  options: WmtsImageryOptions,
  fixed: Readonly<Record<string, string>>,
): (matrix: string, row: number, col: number) => string {
  const format = fixed['Format'] ?? '';
  const resource = layer.resourceUrls.find((r) => r.format === format) ?? layer.resourceUrls[0];
  const encoding = options.encoding ?? (resource ? 'RESTful' : 'KVP');
  if (encoding === 'RESTful') {
    if (!resource)
      throw new SourceConfigError(
        'no-resource-url',
        `WMTS source '${options.id}': layer '${layer.identifier}' has no RESTful tile URL`,
      );
    return (matrix, row, col) =>
      fill(resource.template, { ...fixed, TileMatrix: matrix, TileRow: String(row), TileCol: String(col) });
  }
  const base = capabilities.kvpUrl;
  if (!base)
    throw new SourceConfigError(
      'no-kvp-endpoint',
      `WMTS source '${options.id}': the service declares no KVP GetTile endpoint`,
    );
  const separator = base.includes('?') ? (/[?&]$/.test(base) ? '' : '&') : '?';
  const dimensionPairs = layer.dimensions
    .map((d) => `&${encodeURIComponent(d.identifier)}=${encodeURIComponent(fixed[d.identifier] ?? '')}`)
    .join('');
  const prefix =
    `${base}${separator}SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${encodeURIComponent(layer.identifier)}` +
    `&STYLE=${encodeURIComponent(fixed['Style'] ?? '')}&FORMAT=${encodeURIComponent(format)}` +
    `&TILEMATRIXSET=${encodeURIComponent(fixed['TileMatrixSet'] ?? '')}${dimensionPairs}`;
  return (matrix, row, col) => `${prefix}&TILEMATRIX=${encodeURIComponent(matrix)}&TILEROW=${row}&TILECOL=${col}`;
}

function fixedOf(layer: WmtsLayer, options: WmtsImageryOptions, set: string): Record<string, string> {
  const style =
    options.style ?? layer.styles.find((s) => s.isDefault)?.identifier ?? layer.styles[0]?.identifier ?? 'default';
  const fixed: Record<string, string> = {
    Style: style,
    TileMatrixSet: set,
    Format: chooseFormat(layer, options.format),
  };
  for (const d of layer.dimensions) fixed[d.identifier] = options.dimensions?.[d.identifier] ?? d.defaultValue;
  return fixed;
}

function providerAttribution(options: WmtsImageryOptions, capabilities: WmtsCapabilities): readonly Attribution[] {
  const provider = capabilities.provider;
  return (
    options.attribution ??
    (provider ? [provider.url ? { text: provider.name, url: provider.url } : { text: provider.name }] : [])
  );
}

/**
 * The client-side reprojection of a layer none of whose matrix sets lines up with the engine's schemes, through the
 * first set in a system the application's `transforms` know (F227, ADR 0039); undefined otherwise.
 */
function reprojectedFallback(
  capabilities: WmtsCapabilities,
  layer: WmtsLayer,
  options: WmtsImageryOptions,
): DescribedImagerySource | undefined {
  const transforms = options.transforms;
  if (!transforms) return undefined;
  const links = layer.tileMatrixSetLinks.filter(
    (l) => options.tileMatrixSet === undefined || l.set === options.tileMatrixSet,
  );
  const sets = links.flatMap((link) => {
    const set = capabilities.tileMatrixSets.find((s) => s.identifier === link.set);
    return set ? [{ link, set }] : [];
  });
  if (sets.some(({ set }) => matchMatrixSet(set) !== undefined)) return undefined;
  for (const { link, set } of sets) {
    const pair = transforms(set.crs);
    const coarsest = [...set.matrices].sort((a, b) => b.scaleDenominator - a.scaleDenominator)[0];
    if (!pair || !coarsest) continue;
    const url = urlBuilder(capabilities, layer, options, fixedOf(layer, options, set.identifier));
    const extent = matrixBounds(coarsest);
    const declared = layer.wgs84Bounds ? sourceBoundsOf(layer.wgs84Bounds, pair.toSource) : extent;
    const bounds: SourceBbox = [
      Math.max(extent[0], declared[0]),
      Math.max(extent[1], declared[1]),
      Math.min(extent[2], declared[2]),
      Math.min(extent[3], declared[3]),
    ];
    return reprojectedImagery({
      id: options.id,
      sourceCrs: set.crs,
      toSource: pair.toSource,
      fromSource: pair.fromSource,
      bounds,
      image: (bbox, widthPx, heightPx) => wmtsParts(set.matrices, link.limits, url, bbox, widthPx, heightPx),
      ...(options.transport ? { transport: options.transport } : {}),
      ...(options.maxRequestsPerHost === undefined ? {} : { maxRequestsPerHost: options.maxRequestsPerHost }),
      attribution: providerAttribution(options, capabilities),
      profile: options.profile ?? CUSTOM_PROFILE,
    }) as DescribedImagerySource;
  }
  return undefined;
}

/**
 * A WMTS imagery source (F230): reads the GetCapabilities document, picks the layer's style, format, dimensions and a
 * tile matrix set that lines up with Web Mercator or the geographic scheme (preferring `preferredCrs`, F227), and
 * builds RESTful or KVP GetTile requests; tiles outside the matrix limits or levels are no data. Matrix sets in other
 * reference systems are reprojected on the client when `transforms` knows their system (F226, F227).
 */
export async function wmtsImagery(options: WmtsImageryOptions): Promise<DescribedImagerySource> {
  const capabilities = await loadCapabilities(
    options.capabilities,
    options.fetch,
    options.id,
    'WMTS',
    parseWmtsCapabilities,
  );
  const layer = capabilities.layers.find((l) => l.identifier === options.layer);
  if (!layer)
    throw new SourceConfigError(
      'unknown-layer',
      `WMTS source '${options.id}': no layer '${options.layer}' (offered: ${capabilities.layers.map((l) => l.identifier).join(', ')})`,
    );
  const reprojected = reprojectedFallback(capabilities, layer, options);
  if (reprojected) return reprojected;
  const set = chooseSet(capabilities, layer, options);
  const url = urlBuilder(capabilities, layer, options, fixedOf(layer, options, set.identifier));
  const levels = [...set.matched.levels.keys()];
  const bounds = layer.wgs84Bounds;
  const coverage = bounds ? coverageOf(...bounds) : undefined;
  const extent: TileRectangleRad = { westRad: 0, southRad: 0, eastRad: 0, northRad: 0 };
  const source: DescribedImagerySource = {
    id: options.id,
    tiling: set.matched.tiling === 'mercator' ? WEB_MERCATOR_TILING : GEOGRAPHIC_TILING,
    minLevel: Math.min(...levels),
    maxLevel: Math.max(...levels),
    tileSizePx: set.matched.tileSizePx,
    pixelRatio: 1,
    ...(coverage ? { coverage: [coverage] } : {}),
    decoder: 'image',
    transport: options.transport ?? fetchTransport(),
    ...(options.maxRequestsPerHost === undefined ? {} : { maxRequestsPerHost: options.maxRequestsPerHost }),
    attribution: providerAttribution(options, capabilities),
    profile: options.profile ?? CUSTOM_PROFILE,
    request(coord: TileCoord, out: TileRequest): TileRequest | 'noData' {
      const matrix = set.matched.levels.get(coord.level);
      if (!matrix || !inLevelsAndCoverage(source, coord, extent)) return 'noData';
      const limits = set.limits.get(matrix.identifier);
      const outside =
        limits &&
        (coord.y < limits.minRow || coord.y > limits.maxRow || coord.x < limits.minCol || coord.x > limits.maxCol);
      if (outside || coord.y >= matrix.matrixHeight) return 'noData';
      out.url = url(matrix.identifier, coord.y, coord.x);
      out.hostIndex = 0;
      return out;
    },
  };
  return source;
}

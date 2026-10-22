import { attribute, childText, element, elements, parseXml, path, text, type XmlElement } from '../xml.js';
import { normalizeCrs } from './crs.js';

/** One tile matrix (zoom level) of a tile matrix set. */
export interface WmtsTileMatrix {
  readonly identifier: string;
  readonly scaleDenominator: number;
  /** As written: two numbers in the axis order of the reference system. */
  readonly topLeftCorner: readonly [number, number];
  readonly tileWidth: number;
  readonly tileHeight: number;
  readonly matrixWidth: number;
  readonly matrixHeight: number;
}

/** A tile matrix set. */
export interface WmtsTileMatrixSet {
  readonly identifier: string;
  /** Normalized (`normalizeCrs`). */
  readonly crs: string;
  readonly wellKnownScaleSet?: string;
  readonly matrices: readonly WmtsTileMatrix[];
}

/** The rows and columns of one tile matrix a layer has tiles for. */
export interface WmtsLimits {
  readonly minRow: number;
  readonly maxRow: number;
  readonly minCol: number;
  readonly maxCol: number;
}

/** A layer of a WMTS service. */
export interface WmtsLayer {
  readonly identifier: string;
  readonly title: string;
  readonly formats: readonly string[];
  readonly styles: readonly { readonly identifier: string; readonly isDefault: boolean }[];
  readonly tileMatrixSetLinks: readonly { readonly set: string; readonly limits: ReadonlyMap<string, WmtsLimits> }[];
  readonly resourceUrls: readonly { readonly format: string; readonly template: string }[];
  readonly dimensions: readonly {
    readonly identifier: string;
    readonly defaultValue: string;
    readonly values: readonly string[];
  }[];
  /** Longitude and latitude bounds in degrees: west, south, east, north. */
  readonly wgs84Bounds?: readonly [number, number, number, number];
}

/** What a WMTS GetCapabilities document declares. */
export interface WmtsCapabilities {
  readonly title: string;
  readonly provider?: { readonly name: string; readonly url?: string };
  /** The KVP GetTile endpoint, when the service offers that encoding. */
  readonly kvpUrl?: string;
  readonly layers: readonly WmtsLayer[];
  readonly tileMatrixSets: readonly WmtsTileMatrixSet[];
}

function numbers(value: string): number[] {
  return value.trim().split(/\s+/).map(Number);
}

function finiteInt(value: string, what: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${what} '${value}' is not a non-negative integer`);
  return n;
}

function tileMatrix(node: XmlElement): WmtsTileMatrix {
  const identifier = childText(node, 'Identifier');
  const corner = numbers(childText(node, 'TopLeftCorner'));
  const scaleDenominator = Number(childText(node, 'ScaleDenominator'));
  if (!(scaleDenominator > 0) || corner.length !== 2 || !corner.every(Number.isFinite))
    throw new Error(`tile matrix '${identifier}' has no valid scale or top-left corner`);
  return {
    identifier,
    scaleDenominator,
    topLeftCorner: [corner[0] ?? 0, corner[1] ?? 0],
    tileWidth: finiteInt(childText(node, 'TileWidth'), 'TileWidth'),
    tileHeight: finiteInt(childText(node, 'TileHeight'), 'TileHeight'),
    matrixWidth: finiteInt(childText(node, 'MatrixWidth'), 'MatrixWidth'),
    matrixHeight: finiteInt(childText(node, 'MatrixHeight'), 'MatrixHeight'),
  };
}

function tileMatrixSet(node: XmlElement): WmtsTileMatrixSet {
  const scaleSet = childText(node, 'WellKnownScaleSet');
  return {
    identifier: childText(node, 'Identifier'),
    crs: normalizeCrs(childText(node, 'SupportedCRS')),
    ...(scaleSet ? { wellKnownScaleSet: scaleSet } : {}),
    matrices: elements(node, 'TileMatrix').map(tileMatrix),
  };
}

function limitsOf(link: XmlElement): Map<string, WmtsLimits> {
  const out = new Map<string, WmtsLimits>();
  for (const limit of elements(element(link, 'TileMatrixSetLimits'), 'TileMatrixLimits'))
    out.set(childText(limit, 'TileMatrix'), {
      minRow: finiteInt(childText(limit, 'MinTileRow'), 'MinTileRow'),
      maxRow: finiteInt(childText(limit, 'MaxTileRow'), 'MaxTileRow'),
      minCol: finiteInt(childText(limit, 'MinTileCol'), 'MinTileCol'),
      maxCol: finiteInt(childText(limit, 'MaxTileCol'), 'MaxTileCol'),
    });
  return out;
}

function boundsOf(layer: XmlElement): [number, number, number, number] | undefined {
  const box = element(layer, 'WGS84BoundingBox');
  if (!box) return undefined;
  const [w, s] = numbers(childText(box, 'LowerCorner'));
  const [e, n] = numbers(childText(box, 'UpperCorner'));
  const bounds: [number, number, number, number] = [w ?? NaN, s ?? NaN, e ?? NaN, n ?? NaN];
  return bounds.every(Number.isFinite) ? bounds : undefined;
}

function layer(node: XmlElement): WmtsLayer {
  const bounds = boundsOf(node);
  return {
    identifier: childText(node, 'Identifier'),
    title: childText(node, 'Title'),
    formats: elements(node, 'Format').map((f) => text(f)),
    styles: elements(node, 'Style').map((s) => ({
      identifier: childText(s, 'Identifier'),
      isDefault: attribute(s, 'isDefault') === 'true',
    })),
    tileMatrixSetLinks: elements(node, 'TileMatrixSetLink').map((link) => ({
      set: childText(link, 'TileMatrixSet'),
      limits: limitsOf(link),
    })),
    resourceUrls: elements(node, 'ResourceURL')
      .filter((r) => attribute(r, 'resourceType') === 'tile')
      .map((r) => ({ format: attribute(r, 'format') ?? '', template: attribute(r, 'template') ?? '' })),
    dimensions: elements(node, 'Dimension').map((d) => ({
      identifier: childText(d, 'Identifier'),
      defaultValue: childText(d, 'Default'),
      values: elements(d, 'Value').map((v) => text(v)),
    })),
    ...(bounds ? { wgs84Bounds: bounds } : {}),
  };
}

/** The KVP GetTile endpoint of the operations metadata, if the service declares that encoding. */
function kvpEndpoint(root: XmlElement): string | undefined {
  const operation = elements(element(root, 'OperationsMetadata'), 'Operation').find(
    (o) => attribute(o, 'name') === 'GetTile',
  );
  for (const get of elements(path(operation, 'DCP', 'HTTP'), 'Get')) {
    const encodings = elements(element(get, 'Constraint'), 'AllowedValues').flatMap((a) =>
      elements(a, 'Value').map((v) => text(v)),
    );
    const href = attribute(get, 'href');
    if (href && (encodings.length === 0 || encodings.includes('KVP'))) return href;
  }
  return undefined;
}

/** Parses a WMTS 1.0.0 GetCapabilities document; throws a descriptive error when it is not one. */
export function parseWmtsCapabilities(xml: string): WmtsCapabilities {
  const root = parseXml(xml);
  if (!/Capabilities$/.test(root.tagName)) throw new Error(`the root element is <${root.tagName}>, not <Capabilities>`);
  const contents = element(root, 'Contents');
  if (!contents) throw new Error('the document has no <Contents>');
  const providerName = childText(element(root, 'ServiceProvider'), 'ProviderName');
  const providerUrl = attribute(path(root, 'ServiceProvider', 'ProviderSite'), 'href');
  const kvpUrl = kvpEndpoint(root);
  return {
    title: childText(element(root, 'ServiceIdentification'), 'Title'),
    ...(providerName
      ? { provider: providerUrl ? { name: providerName, url: providerUrl } : { name: providerName } }
      : {}),
    ...(kvpUrl ? { kvpUrl } : {}),
    layers: elements(contents, 'Layer').map(layer),
    tileMatrixSets: elements(contents, 'TileMatrixSet').map(tileMatrixSet),
  };
}

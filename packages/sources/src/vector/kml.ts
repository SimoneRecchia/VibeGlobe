import { unzipSync } from 'fflate';
import { attribute, childText, element, elements, parseXml, text, type XmlElement } from '../xml.js';
import type { FeatureIssue, Geometry, Position, VectorFeature } from './features.js';

/** How a KML geometry's heights are meant (`altitudeMode`, with the `gx:` sea-floor modes). */
export type AltitudeMode = 'clampToGround' | 'relativeToGround' | 'absolute' | 'clampToSeaFloor' | 'relativeToSeaFloor';

/** A resolved KML style: colors as `#rrggbbaa`, widths in pixels. */
export interface KmlStyle {
  readonly iconHref?: string;
  readonly iconScale?: number;
  readonly iconColor?: string;
  readonly labelColor?: string;
  readonly lineColor?: string;
  readonly lineWidthPx?: number;
  readonly polygonColor?: string;
  readonly fill?: boolean;
  readonly outline?: boolean;
}

/** A placemark: a vector feature with its KML name, description, style, folders and altitude mode. */
export interface KmlFeature extends VectorFeature {
  readonly name?: string;
  readonly description?: string;
  /** The normal style (a StyleMap's `normal` pair), inline style over shared style. */
  readonly style?: KmlStyle;
  /** The StyleMap's `highlight` style, when there is one. */
  readonly highlightStyle?: KmlStyle;
  /** Names of the folders and documents that contain it, outermost first. */
  readonly folders: readonly string[];
  readonly altitudeMode: AltitudeMode;
}

/** An image draped over a latitude-longitude box. */
export interface GroundOverlay {
  readonly name?: string;
  readonly href: string;
  readonly north: number;
  readonly south: number;
  readonly east: number;
  readonly west: number;
  /** Counter-clockwise rotation of the image about the box center, degrees. */
  readonly rotationDeg: number;
  readonly folders: readonly string[];
}

/** What {@link parseKml} returns. */
export interface ParsedKml {
  readonly features: readonly KmlFeature[];
  readonly groundOverlays: readonly GroundOverlay[];
  /** Files of a KMZ archive other than the document (icons, overlay images), by their path in the archive. */
  readonly resources: Readonly<Record<string, Uint8Array>>;
  readonly issues: readonly FeatureIssue[];
}

const ALTITUDE_MODES = new Set<string>([
  'clampToGround',
  'relativeToGround',
  'absolute',
  'clampToSeaFloor',
  'relativeToSeaFloor',
]);
const MAX_DEPTH = 32;
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;

/** KML `aabbggrr` as `#rrggbbaa`. */
function color(value: string): string | undefined {
  if (!/^[0-9a-f]{8}$/i.test(value)) return undefined;
  const v = value.toLowerCase();
  return `#${v.slice(6, 8)}${v.slice(4, 6)}${v.slice(2, 4)}${v.slice(0, 2)}`;
}

function finite(value: string): number | undefined {
  const n = Number(value);
  return value !== '' && Number.isFinite(n) ? n : undefined;
}

function styleOf(node: XmlElement): KmlStyle {
  const icon = element(node, 'IconStyle');
  const line = element(node, 'LineStyle');
  const poly = element(node, 'PolyStyle');
  const entries: [string, unknown][] = [
    ['iconHref', childText(element(icon, 'Icon'), 'href') || undefined],
    ['iconScale', finite(childText(icon, 'scale'))],
    ['iconColor', color(childText(icon, 'color'))],
    ['labelColor', color(childText(element(node, 'LabelStyle'), 'color'))],
    ['lineColor', color(childText(line, 'color'))],
    ['lineWidthPx', finite(childText(line, 'width'))],
    ['polygonColor', color(childText(poly, 'color'))],
    ['fill', poly && childText(poly, 'fill') ? childText(poly, 'fill') !== '0' : undefined],
    ['outline', poly && childText(poly, 'outline') ? childText(poly, 'outline') !== '0' : undefined],
  ];
  return Object.fromEntries(entries.filter(([, v]) => v !== undefined)) as KmlStyle;
}

/** Shared styles and style maps by id, from every `Style` and `StyleMap` in the document. */
function collectStyles(
  node: XmlElement,
  styles: Map<string, KmlStyle>,
  maps: Map<string, Record<string, string>>,
  depth = 0,
): void {
  if (depth > MAX_DEPTH) return;
  for (const child of elements(node)) {
    const name = child.tagName.replace(/^.*:/, '');
    const id = attribute(child, 'id');
    if (name === 'Style' && id) styles.set(id, styleOf(child));
    else if (name === 'StyleMap' && id)
      maps.set(
        id,
        Object.fromEntries(elements(child, 'Pair').map((p) => [childText(p, 'key'), childText(p, 'styleUrl')])),
      );
    else if (name === 'Document' || name === 'Folder') collectStyles(child, styles, maps, depth + 1);
  }
}

function coordinates(node: XmlElement | undefined, minimum: number): Position[] {
  const out = childText(node, 'coordinates')
    .split(/\s+/)
    .filter(Boolean)
    .map((tuple): Position => {
      const [lon = NaN, lat = NaN, height] = tuple.split(',').map(Number);
      if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lat) > 90)
        throw new Error(`invalid coordinates '${tuple}'`);
      return height !== undefined && Number.isFinite(height) ? [lon, lat, height] : [lon, lat];
    });
  if (out.length < minimum) throw new Error(`needs at least ${minimum} coordinates`);
  return out;
}

function closed(ring: Position[]): Position[] {
  const first = ring[0];
  const last = ring[ring.length - 1];
  return first && last && (first[0] !== last[0] || first[1] !== last[1]) ? [...ring, first] : ring;
}

function geometryOf(node: XmlElement, depth = 0): Geometry | undefined {
  switch (node.tagName.replace(/^.*:/, '')) {
    case 'Point':
      return { type: 'Point', coordinates: coordinates(node, 1)[0] ?? [0, 0] };
    case 'LineString':
      return { type: 'LineString', coordinates: coordinates(node, 2) };
    case 'LinearRing':
      return { type: 'Polygon', coordinates: [closed(coordinates(node, 3))] };
    case 'Polygon': {
      const outer = coordinates(element(element(node, 'outerBoundaryIs'), 'LinearRing'), 3);
      const inner = elements(node, 'innerBoundaryIs').map((b) => closed(coordinates(element(b, 'LinearRing'), 3)));
      return { type: 'Polygon', coordinates: [closed(outer), ...inner] };
    }
    case 'MultiGeometry': {
      if (depth > MAX_DEPTH) throw new Error('MultiGeometry nested too deeply');
      const parts = elements(node).flatMap((child) => geometryOf(child, depth + 1) ?? []);
      return { type: 'GeometryCollection', geometries: parts };
    }
    default:
      return undefined;
  }
}

/** Elements whose `altitudeMode` applies to the feature; a LookAt's or a Camera's is about the view, not the data. */
const GEOMETRY_TAGS = new Set(['Point', 'LineString', 'LinearRing', 'Polygon', 'MultiGeometry']);

function altitudeModeOf(placemark: XmlElement): AltitudeMode {
  const geometries = elements(placemark).filter((node) => GEOMETRY_TAGS.has(node.tagName.replace(/^.*:/, '')));
  for (const node of [placemark, ...geometries]) {
    const mode = childText(node, 'altitudeMode');
    if (ALTITUDE_MODES.has(mode)) return mode as AltitudeMode;
  }
  return 'clampToGround';
}

function extendedData(placemark: XmlElement): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const data = element(placemark, 'ExtendedData');
  for (const d of elements(data, 'Data')) {
    const name = attribute(d, 'name');
    if (name) out[name] = childText(d, 'value');
  }
  for (const schema of elements(data, 'SchemaData'))
    for (const simple of elements(schema, 'SimpleData')) {
      const name = attribute(simple, 'name');
      if (name) out[name] = text(simple);
    }
  return out;
}

interface Context {
  readonly styles: Map<string, KmlStyle>;
  readonly maps: Map<string, Record<string, string>>;
  readonly features: KmlFeature[];
  readonly overlays: GroundOverlay[];
  readonly issues: FeatureIssue[];
  index: number;
}

function resolveStyle(url: string, context: Context, key: 'normal' | 'highlight' = 'normal'): KmlStyle | undefined {
  const id = url.replace(/^.*#/, '');
  const map = context.maps.get(id);
  if (map) return map[key] ? context.styles.get(map[key].replace(/^.*#/, '')) : undefined;
  return key === 'normal' ? context.styles.get(id) : undefined;
}

function placemark(node: XmlElement, folders: readonly string[], context: Context): KmlFeature {
  const geometryNode = elements(node).find((child) =>
    /(Point|LineString|LinearRing|Polygon|MultiGeometry)$/.test(child.tagName),
  );
  const geometry = geometryNode ? (geometryOf(geometryNode) ?? null) : null;
  const url = childText(node, 'styleUrl');
  const inline = element(node, 'Style');
  const shared = url ? resolveStyle(url, context) : undefined;
  const style = inline ? { ...shared, ...styleOf(inline) } : shared;
  const highlight = url ? resolveStyle(url, context, 'highlight') : undefined;
  const name = childText(node, 'name');
  const description = childText(node, 'description');
  const id = attribute(node, 'id');
  return {
    ...(id ? { id } : {}),
    geometry,
    properties: { ...(name ? { name } : {}), ...(description ? { description } : {}), ...extendedData(node) },
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    ...(style ? { style } : {}),
    ...(highlight ? { highlightStyle: highlight } : {}),
    folders,
    altitudeMode: altitudeModeOf(node),
  };
}

function groundOverlay(node: XmlElement, folders: readonly string[]): GroundOverlay {
  const box = element(node, 'LatLonBox');
  const [north, south, east, west] = ['north', 'south', 'east', 'west'].map((n) => finite(childText(box, n)));
  const href = childText(element(node, 'Icon'), 'href');
  if (north === undefined || south === undefined || east === undefined || west === undefined || !href)
    throw new Error('a GroundOverlay needs an Icon href and a complete LatLonBox');
  const name = childText(node, 'name');
  return {
    ...(name ? { name } : {}),
    href,
    north,
    south,
    east,
    west,
    rotationDeg: finite(childText(box, 'rotation')) ?? 0,
    folders,
  };
}

function walk(node: XmlElement, folders: readonly string[], context: Context, depth: number): void {
  if (depth > MAX_DEPTH) return;
  for (const child of elements(node)) {
    const name = child.tagName.replace(/^.*:/, '');
    if (name === 'Document' || name === 'Folder') {
      const title = childText(child, 'name');
      walk(child, title ? [...folders, title] : folders, context, depth + 1);
      continue;
    }
    if (name !== 'Placemark' && name !== 'GroundOverlay') continue;
    const index = context.index++;
    try {
      if (name === 'Placemark') context.features.push(placemark(child, folders, context));
      else context.overlays.push(groundOverlay(child, folders));
    } catch (error) {
      context.issues.push({ index, message: error instanceof Error ? error.message : String(error) });
    }
  }
}

/** Unpacks a KMZ archive: its main document (`doc.kml`, else the first `.kml`) and every other file. */
function unpack(bytes: Uint8Array): { kml: string; resources: Record<string, Uint8Array> } {
  if (bytes.byteLength > MAX_ARCHIVE_BYTES) throw new Error('the KMZ archive is too large');
  const files = unzipSync(bytes);
  const names = Object.keys(files);
  const main = names.find((n) => n.toLowerCase() === 'doc.kml') ?? names.find((n) => n.toLowerCase().endsWith('.kml'));
  if (!main) throw new Error('the KMZ archive holds no .kml document');
  const resources: Record<string, Uint8Array> = {};
  for (const name of names) if (name !== main && !name.endsWith('/')) resources[name] = files[name] ?? new Uint8Array();
  return { kml: new TextDecoder().decode(files[main]), resources };
}

/**
 * Parses a KML document or a KMZ archive (F237): placemarks with points, lines, polygons with holes and
 * MultiGeometry, folders, shared and inline styles and StyleMaps, ExtendedData, altitude modes, and ground overlays,
 * with a KMZ archive's icons and images extracted. Problems are reported per placemark; it never throws.
 */
export function parseKml(input: string | Uint8Array | ArrayBuffer): ParsedKml {
  const context: Context = { styles: new Map(), maps: new Map(), features: [], overlays: [], issues: [], index: 0 };
  let resources: Record<string, Uint8Array> = {};
  try {
    let kml: string;
    if (typeof input === 'string') kml = input;
    else {
      const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
      // A ZIP archive starts with "PK".
      if (bytes[0] === 0x50 && bytes[1] === 0x4b) ({ kml, resources } = unpack(bytes));
      else kml = new TextDecoder().decode(bytes);
    }
    const root = parseXml(kml);
    if (root.tagName.replace(/^.*:/, '') !== 'kml') throw new Error(`the root element is <${root.tagName}>, not <kml>`);
    collectStyles(root, context.styles, context.maps);
    walk(root, [], context, 0);
  } catch (error) {
    context.issues.push({ index: -1, message: error instanceof Error ? error.message : String(error) });
  }
  return { features: context.features, groundOverlays: context.overlays, resources, issues: context.issues };
}

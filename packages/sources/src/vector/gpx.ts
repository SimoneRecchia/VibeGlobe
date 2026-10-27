// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { attribute, childText, element, elements, parseXml, type XmlElement } from '../xml.js';
import type { FeatureIssue, Position, VectorFeature } from './features.js';

/** A GPX feature: a waypoint (Point), a route (LineString) or a track (MultiLineString, one line per segment). */
export interface GpxFeature extends VectorFeature {
  readonly kind: 'waypoint' | 'route' | 'track';
  /**
   * Time of each point in milliseconds since the epoch (NaN where a point has none): one entry for a waypoint, one
   * per route point, and one array per track segment.
   */
  readonly times: readonly number[] | readonly (readonly number[])[];
}

/** What {@link parseGpx} returns. */
export interface ParsedGpx {
  /** '1.0' or '1.1'. */
  readonly version: string;
  readonly features: readonly GpxFeature[];
  readonly issues: readonly FeatureIssue[];
}

function point(node: XmlElement): { position: Position; time: number } {
  const lat = Number(attribute(node, 'lat'));
  const lon = Number(attribute(node, 'lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180)
    throw new Error(`invalid point lat="${attribute(node, 'lat') ?? ''}" lon="${attribute(node, 'lon') ?? ''}"`);
  const elevation = childText(node, 'ele');
  const height = elevation === '' ? NaN : Number(elevation);
  const time = childText(node, 'time');
  return {
    position: Number.isFinite(height) ? [lon, lat, height] : [lon, lat],
    time: time === '' ? NaN : Date.parse(time),
  };
}

/** Name, description, comment, type, symbol and links of a waypoint, route or track. */
function propertiesOf(node: XmlElement): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ['name', 'desc', 'cmt', 'type', 'sym', 'src']) {
    const value = childText(node, key);
    if (value) out[key] = value;
  }
  // GPX 1.1 links are elements with an href; GPX 1.0 has a <url> element.
  const links = elements(node, 'link').flatMap((l) => attribute(l, 'href') ?? []);
  const url = childText(node, 'url');
  if (url) links.push(url);
  if (links.length > 0) out['links'] = links;
  return out;
}

function waypoint(node: XmlElement): GpxFeature {
  const { position, time } = point(node);
  return {
    kind: 'waypoint',
    geometry: { type: 'Point', coordinates: position },
    properties: propertiesOf(node),
    times: [time],
  };
}

function route(node: XmlElement): GpxFeature {
  const points = elements(node, 'rtept').map(point);
  return {
    kind: 'route',
    geometry: line(points.map((p) => p.position)),
    properties: propertiesOf(node),
    times: points.map((p) => p.time),
  };
}

/** A line, or a point or nothing for the one-point and empty routes devices write. */
function line(positions: Position[]): GpxFeature['geometry'] {
  if (positions.length >= 2) return { type: 'LineString', coordinates: positions };
  const [only] = positions;
  return only ? { type: 'Point', coordinates: only } : null;
}

/** Segments of two points or more are lines; a track with only shorter segments keeps its points. */
function track(node: XmlElement): GpxFeature {
  const all = elements(node, 'trkseg').map((segment) => elements(segment, 'trkpt').map(point));
  const segments = all.filter((segment) => segment.length >= 2);
  const loose = all.flat();
  const geometry: GpxFeature['geometry'] =
    segments.length > 0
      ? { type: 'MultiLineString', coordinates: segments.map((s) => s.map((p) => p.position)) }
      : loose.length > 0
        ? { type: 'MultiPoint', coordinates: loose.map((p) => p.position) }
        : null;
  return {
    kind: 'track',
    geometry,
    properties: propertiesOf(node),
    times: (segments.length > 0 ? segments : [loose]).map((s) => s.map((p) => p.time)),
  };
}

/**
 * Parses a GPX 1.0 or 1.1 document (F238): waypoints, routes and tracks with their segments, elevations (heights in
 * meters) and times. A malformed waypoint, route or track is reported in `issues` and the others are kept; it never
 * throws.
 */
export function parseGpx(input: string | Uint8Array | ArrayBuffer): ParsedGpx {
  const features: GpxFeature[] = [];
  const issues: FeatureIssue[] = [];
  let version = '';
  try {
    const root = parseXml(typeof input === 'string' ? input : new TextDecoder().decode(input));
    if (root.tagName.replace(/^.*:/, '') !== 'gpx') throw new Error(`the root element is <${root.tagName}>, not <gpx>`);
    version = attribute(root, 'version') ?? '';
    let index = 0;
    for (const child of elements(root)) {
      const name = child.tagName.replace(/^.*:/, '');
      const read = name === 'wpt' ? waypoint : name === 'rte' ? route : name === 'trk' ? track : undefined;
      if (!read) continue;
      const at = index++;
      try {
        features.push(read(child));
      } catch (error) {
        issues.push({ index: at, message: error instanceof Error ? error.message : String(error) });
      }
    }
    if (!element(root, 'wpt') && !element(root, 'rte') && !element(root, 'trk'))
      issues.push({ index: -1, message: 'no waypoint, route or track' });
  } catch (error) {
    issues.push({ index: -1, message: error instanceof Error ? error.message : String(error) });
  }
  return { version, features, issues };
}

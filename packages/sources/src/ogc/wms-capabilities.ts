// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { attribute, childText, element, elements, parseXml, path, text, type XmlElement } from '../xml.js';
import { normalizeCrs } from './crs.js';

/** A named layer of a WMS service, with what it inherits from its parents. */
export interface WmsLayer {
  readonly name: string;
  readonly title: string;
  /** Normalized reference systems (`normalizeCrs`), inherited ones included. */
  readonly crs: readonly string[];
  /** The reference-system codes as the service writes them (for example `EPSG:900913`), inherited ones included. */
  readonly advertisedCrs: readonly string[];
  readonly styles: readonly string[];
  /** Longitude and latitude bounds in degrees: west, south, east, north. */
  readonly bounds?: readonly [number, number, number, number];
  readonly attribution?: { readonly text: string; readonly url?: string };
  readonly opaque: boolean;
}

/** What a WMS 1.1.1 or 1.3.0 GetCapabilities document declares. */
export interface WmsCapabilities {
  readonly version: '1.1.1' | '1.3.0';
  readonly title: string;
  /** The GetMap endpoint. */
  readonly getMapUrl?: string;
  readonly formats: readonly string[];
  readonly layers: readonly WmsLayer[];
}

interface Inherited {
  crs: string[];
  advertisedCrs: string[];
  bounds: [number, number, number, number] | undefined;
  attribution: WmsLayer['attribution'];
}

function boundsOf(node: XmlElement): [number, number, number, number] | undefined {
  const box = element(node, 'EX_GeographicBoundingBox');
  const values = box
    ? ['westBoundLongitude', 'southBoundLatitude', 'eastBoundLongitude', 'northBoundLatitude'].map((n) =>
        Number(childText(box, n)),
      )
    : ['minx', 'miny', 'maxx', 'maxy'].map((n) => Number(attribute(element(node, 'LatLonBoundingBox'), n)));
  return values.every(Number.isFinite) && (box || element(node, 'LatLonBoundingBox'))
    ? [values[0] ?? 0, values[1] ?? 0, values[2] ?? 0, values[3] ?? 0]
    : undefined;
}

function attributionOf(node: XmlElement): WmsLayer['attribution'] {
  const attribution = element(node, 'Attribution');
  const title = childText(attribution, 'Title');
  if (!title) return undefined;
  const url = attribute(element(attribution, 'OnlineResource'), 'href');
  return url ? { text: title, url } : { text: title };
}

function collectLayers(node: XmlElement, parent: Inherited, out: WmsLayer[], depth: number): void {
  if (depth > 32) return;
  // 1.1.1 may list several SRS in one element, separated by spaces.
  const advertised = [...elements(node, 'CRS'), ...elements(node, 'SRS')]
    .flatMap((c) => text(c).split(/\s+/))
    .filter(Boolean);
  const inherited: Inherited = {
    crs: [...new Set([...parent.crs, ...advertised.map(normalizeCrs)])],
    advertisedCrs: [...new Set([...parent.advertisedCrs, ...advertised])],
    bounds: boundsOf(node) ?? parent.bounds,
    attribution: attributionOf(node) ?? parent.attribution,
  };
  const name = childText(node, 'Name');
  if (name) {
    out.push({
      name,
      title: childText(node, 'Title'),
      crs: inherited.crs,
      advertisedCrs: inherited.advertisedCrs,
      styles: elements(node, 'Style').map((s) => childText(s, 'Name')),
      ...(inherited.bounds ? { bounds: inherited.bounds } : {}),
      ...(inherited.attribution ? { attribution: inherited.attribution } : {}),
      opaque: attribute(node, 'opaque') === '1' || attribute(node, 'opaque') === 'true',
    });
  }
  for (const child of elements(node, 'Layer')) collectLayers(child, inherited, out, depth + 1);
}

/** Parses a WMS 1.1.1 or 1.3.0 GetCapabilities document; throws a descriptive error when it is not one. */
export function parseWmsCapabilities(xml: string): WmsCapabilities {
  const root = parseXml(xml);
  if (!/^(WMT_MS_Capabilities|WMS_Capabilities)$/.test(root.tagName.replace(/^.*:/, '')))
    throw new Error(`the root element is <${root.tagName}>, not <WMS_Capabilities> or <WMT_MS_Capabilities>`);
  const version = attribute(root, 'version') === '1.3.0' ? '1.3.0' : '1.1.1';
  const capability = element(root, 'Capability');
  const getMap = path(capability, 'Request', 'GetMap');
  const getMapUrl = attribute(path(getMap, 'DCPType', 'HTTP', 'Get', 'OnlineResource'), 'href');
  const layers: WmsLayer[] = [];
  for (const top of elements(capability, 'Layer'))
    collectLayers(top, { crs: [], advertisedCrs: [], bounds: undefined, attribution: undefined }, layers, 0);
  return {
    version,
    title: childText(element(root, 'Service'), 'Title'),
    ...(getMapUrl ? { getMapUrl } : {}),
    formats: elements(getMap, 'Format').map((f) => text(f)),
    layers,
  };
}

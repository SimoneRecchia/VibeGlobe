import type { SourceBbox } from './warp-math.js';

/** Parameters of {@link wmsGetMapUrl}. */
export interface WmsGetMapParameters {
  /** Layer names, drawn bottom first. */
  readonly layers: readonly string[];
  /** The reference system of `bbox`, such as 'EPSG:32632'. */
  readonly crs: string;
  /** The image's box in `crs` units: west, south, east, north (easting and northing for projected systems). */
  readonly bbox: SourceBbox;
  readonly widthPx: number;
  readonly heightPx: number;
  /** Image format (default `image/png`). */
  readonly format?: string;
  /** One style per layer; the defaults when omitted. */
  readonly styles?: readonly string[];
  /** Asks for a transparent background (default true). */
  readonly transparent?: boolean;
}

/**
 * Geographic systems whose WMS 1.3.0 axis order is latitude first (EPSG:4326 and the other EPSG geographic systems of
 * common use); `CRS:84` stays longitude first, projected systems easting first.
 */
const LATITUDE_FIRST = new Set(['EPSG:4326', 'EPSG:4258', 'EPSG:4269', 'EPSG:4979', 'EPSG:4937']);

/**
 * A WMS 1.3.0 GetMap URL for an image of `bbox` in `crs`: the BBOX in the axis order of the reference system
 * (latitude, longitude for EPSG:4326; easting, northing for projected systems such as UTM). Pure; `baseUrl` may
 * already carry query parameters.
 */
export function wmsGetMapUrl(baseUrl: string, parameters: WmsGetMapParameters): string {
  const { layers, crs, bbox, widthPx, heightPx } = parameters;
  const [w, s, e, n] = bbox;
  const box = LATITUDE_FIRST.has(crs.toUpperCase()) ? [s, w, n, e] : [w, s, e, n];
  const separator = baseUrl.includes('?') ? (/[?&]$/.test(baseUrl) ? '' : '&') : '?';
  const styles = parameters.styles ?? layers.map(() => '');
  return (
    `${baseUrl}${separator}SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0` +
    `&LAYERS=${layers.map(encodeURIComponent).join(',')}&STYLES=${styles.map(encodeURIComponent).join(',')}` +
    `&FORMAT=${encodeURIComponent(parameters.format ?? 'image/png')}` +
    `&TRANSPARENT=${parameters.transparent === false ? 'FALSE' : 'TRUE'}&CRS=${encodeURIComponent(crs)}` +
    `&WIDTH=${Math.round(widthPx)}&HEIGHT=${Math.round(heightPx)}` +
    `&BBOX=${box.map((v) => Number(v.toFixed(9))).join(',')}`
  );
}

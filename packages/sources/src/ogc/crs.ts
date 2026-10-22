/**
 * Reference system identifiers as OGC services write them, reduced to one code: `EPSG:3857` (with its historical
 * aliases), `EPSG:4326` (latitude first in WMS 1.3.0 and WMTS), `CRS:84` (longitude first), or `EPSG:<n>`.
 */
export function normalizeCrs(raw: string): string {
  const value = raw.trim();
  if (/CRS:?84$/i.test(value) || /OGC(?::[\d.]*)?:CRS84$/i.test(value) || /OGC\/[\d.]+\/CRS84$/i.test(value))
    return 'CRS:84';
  const code = /EPSG(?::[\d.]*)*:+(\d+)$/i.exec(value)?.[1] ?? /\/EPSG\/[\d.]+\/(\d+)$/i.exec(value)?.[1];
  if (code === undefined) return value.toUpperCase();
  if (['900913', '3785', '102100', '102113'].includes(code)) return 'EPSG:3857';
  return `EPSG:${code}`;
}

/** The reference systems the engine draws without reprojection, by the tiling scheme they map to. */
export function tilingOfCrs(crs: string): 'mercator' | 'geographic' | undefined {
  if (crs === 'EPSG:3857') return 'mercator';
  if (crs === 'EPSG:4326' || crs === 'CRS:84') return 'geographic';
  return undefined;
}

/** Half the Web Mercator world, meters. */
export const MERCATOR_HALF_WORLD_M = 20037508.342789244;

/** Meters per degree at the equator of the WGS84 ellipsoid, as OGC scale denominators use for degrees. */
export const METERS_PER_DEGREE = (2 * Math.PI * 6378137) / 360;

/** Meters per pixel of the standardized rendering pixel (0.28 mm) that scale denominators assume. */
export const STANDARD_PIXEL_M = 0.00028;

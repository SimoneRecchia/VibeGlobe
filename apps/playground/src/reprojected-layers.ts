// Fixture imagery in UTM zones reprojected on the client (F226): `?utm=32632,32633` adds one source per zone, served
// by the fixture server's WMS-style UTM endpoint and warped into Web Mercator tiles.
import type { ImagerySource } from '@vibeglobe/core';
import { transformCoordinates } from '@vibeglobe/gis';
import { reprojectedImagery, wmsGetMapUrl, type SourceBbox } from '@vibeglobe/sources';

/** The Italian part of each zone, degrees: west, south, east, north. */
const ZONE_EXTENT_DEG: Readonly<Record<string, readonly [number, number, number, number]>> = {
  '32632': [6, 36, 12, 47.5],
  '32633': [12, 36, 18, 47.5],
};

/** The box in a zone's meters enclosing a longitude-latitude rectangle, from points along its edges. */
function metersBox(crs: string, [w, s, e, n]: readonly [number, number, number, number]): SourceBbox {
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let k = 0; k <= 32; k++) {
    const t = k / 32;
    for (const [lon, lat] of [
      [w + (e - w) * t, s],
      [w + (e - w) * t, n],
      [w, s + (n - s) * t],
      [e, s + (n - s) * t],
    ] as const) {
      const p = transformCoordinates({ x: lon, y: lat }, 'EPSG:4326', crs);
      [minX, minY, maxX, maxY] = [Math.min(minX, p.x), Math.min(minY, p.y), Math.max(maxX, p.x), Math.max(maxY, p.y)];
    }
  }
  return [minX, minY, maxX, maxY];
}

/** The reprojected UTM fixture sources `?utm=` asks for (ids `utm-<code>`), bottom first. */
export function utmLayers(params: URLSearchParams, base: string, session: string): ImagerySource[] {
  const spec = params.get('utm');
  if (!spec) return [];
  return spec
    .split(',')
    .filter((code) => ZONE_EXTENT_DEG[code] !== undefined)
    .map((code) => {
      const crs = `EPSG:${code}`;
      const extent = ZONE_EXTENT_DEG[code] ?? [0, 0, 0, 0];
      return reprojectedImagery({
        id: `utm-${code}`,
        sourceCrs: crs,
        toSource: (lon, lat) => {
          const p = transformCoordinates({ x: lon, y: lat }, 'EPSG:4326', crs);
          return [p.x, p.y];
        },
        fromSource: (x, y) => {
          const p = transformCoordinates({ x, y }, crs, 'EPSG:4326');
          return [p.x, p.y];
        },
        bounds: metersBox(crs, extent),
        image: (bbox, widthPx, heightPx) =>
          wmsGetMapUrl(`${base}fixture-tiles/${session}/wms-utm`, { layers: ['utm'], crs, bbox, widthPx, heightPx }),
        maxLevel: 18,
        attribution: [{ text: `Fixture UTM ${code.slice(3)}N` }],
      });
    });
}

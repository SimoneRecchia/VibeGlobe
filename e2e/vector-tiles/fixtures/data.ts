// Synthetic geography of the vector tile fixtures (ADR 0131): coarse continents, a graticule and places for the
// globe views; a Milan-like city (roads of every class with names, a canal with a bridge and a tunnel, buildings with
// and without height tags, building parts); roads on the fixture terrain's peak; towers of known height at latitudes
// 0, 45 and 60 degrees. Coordinates are longitude and latitude in degrees. All of it is invented, not map data.

/** A ring or line of longitude, latitude pairs. */
export type Ring = [number, number][];

/** One fixture feature: its source layer, the zoom it appears from, its geometry and properties. */
export interface GeoFeature {
  readonly layer: string;
  readonly minzoom: number;
  readonly type: 'Point' | 'LineString' | 'Polygon';
  /** Points: one part with one point. Lines: parts. Polygons: rings, exterior first. */
  readonly coordinates: readonly (readonly (readonly [number, number])[])[];
  readonly properties: Readonly<Record<string, string | number | boolean>>;
  readonly id?: number;
}

/** Areas that get tiles beyond the world zooms: west, south, east, north. */
export const DETAIL_AREAS: readonly (readonly [number, number, number, number])[] = [
  [9.15, 45.44, 9.23, 45.49], // the city
  [6.8, 45.66, 6.92, 45.74], // the peak of the fixture terrain
  [9.99, -0.01, 10.01, 0.01], // the towers at 0, 45 and 60 degrees
  [9.99, 44.99, 10.01, 45.01],
  [9.99, 59.99, 10.01, 60.01],
];

import { cityBuildings, cityRoads, mountainRoads, pois, towers, waterAndParks } from './city.ts';
import { CONTINENTS, graticule, places } from './world.ts';

/** Every fixture feature. */
export function allFeatures(): GeoFeature[] {
  return [
    ...CONTINENTS.map((ring, i): GeoFeature => ({
      layer: 'landcover',
      minzoom: 0,
      type: 'Polygon',
      coordinates: [[...ring, ring[0] ?? [0, 0]]],
      properties: { class: 'land' },
      id: 100 + i,
    })),
    ...graticule(),
    ...places(),
    ...cityRoads(),
    ...cityBuildings(),
    ...waterAndParks(),
    ...mountainRoads(),
    ...pois(),
    ...towers(),
  ];
}

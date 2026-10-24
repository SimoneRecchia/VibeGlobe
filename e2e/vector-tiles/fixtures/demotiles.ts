// Fixture tiles in the schema of MapLibre's demotiles style (F444): `countries` polygons with `ADM0_A3`, `centroids`
// points with `ABBREV` and `NAME`, and `geolines` (the equator, tropics and polar circles). The style itself is kept
// verbatim in apps/playground/public/vector-tiles/styles/demotiles.json (BSD-3-Clause, MapLibre); the playground maps
// its demotiles.maplibre.org URLs to these files. Invented geography.
import type { GeoFeature } from './data.ts';
import { CONTINENTS, ITALY } from './world.ts';

/** The continents' country codes, in `CONTINENTS` order: one of each fill color group of the style, and Italy. */
const CODES: readonly (readonly [string, string, number, number])[] = [
  ['CHN', 'China', 95, 45],
  ['DEU', 'Germany', 20, 7],
  ['BRA', 'Brazil', -55, -10],
  ['CAN', 'Canada', -100, 58],
  ['AUS', 'Australia', 134, -25],
  ['UKR', 'Ukraine', 30, 49],
  ['NZL', 'New Zealand', 170, -42],
  ['ATA', 'Antarctica', 0, -80],
];

const GEOLINES: readonly (readonly [string, number])[] = [
  ['Equator', 0],
  ['Tropic of Cancer', 23.44],
  ['Tropic of Capricorn', -23.44],
  ['Arctic Circle', 66.56],
  ['Antarctic Circle', -66.56],
];

/** Every feature of the demotiles fixture tiles. */
export function demotilesFeatures(): GeoFeature[] {
  const countries = [...CONTINENTS, ITALY].map((ring, i): GeoFeature => {
    const [code] = i < CONTINENTS.length ? (CODES[i] ?? ['XXX']) : ['ITA'];
    return {
      layer: 'countries',
      minzoom: 0,
      type: 'Polygon',
      coordinates: [[...ring, ring[0] ?? [0, 0]]],
      properties: { ADM0_A3: code },
      id: 1 + i,
    };
  });
  const centroids = [...CODES.slice(0, CONTINENTS.length), ['ITA', 'Italy', 12.5, 42.5] as const].map(
    ([code, name, lon, lat], i): GeoFeature => ({
      layer: 'centroids',
      minzoom: 0,
      type: 'Point',
      coordinates: [[[lon, lat]]],
      properties: { ADM0_A3: code, ABBREV: `${name.slice(0, 4)}.`, NAME: name },
      id: 100 + i,
    }),
  );
  const geolines = GEOLINES.flatMap(([name, lat]) =>
    // Two halves meeting at the antimeridian, as a tiled line must.
    [
      [-180, 0],
      [0, 180],
    ].map(([from = 0, to = 0]): GeoFeature => ({
      layer: 'geolines',
      minzoom: 0,
      type: 'LineString',
      coordinates: [Array.from({ length: 19 }, (_, k): [number, number] => [from + ((to - from) * k) / 18, lat])],
      properties: { name },
    })),
  );
  return [...countries, ...centroids, ...geolines];
}

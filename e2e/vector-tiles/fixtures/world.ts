// Fixture geography of the globe views: coarse continents, Italy, a graticule and places (ADR 0131). Invented data.
import type { GeoFeature, Ring } from './data.ts';

export const CONTINENTS: readonly Ring[] = [
  // Eurasia, ending at the antimeridian; its continuation east of it is a separate piece.
  [
    [-10, 36],
    [-10, 58],
    [5, 62],
    [25, 71],
    [60, 70],
    [100, 77],
    [140, 72],
    [180, 68],
    [180, 62],
    [160, 58],
    [140, 50],
    [130, 35],
    [120, 22],
    [105, 10],
    [95, 15],
    [80, 8],
    [72, 20],
    [58, 25],
    [50, 30],
    [35, 32],
    [28, 36],
    [20, 40],
    [15, 38],
    [8, 44],
    [-5, 36],
  ],
  [
    [-180, 68],
    [-170, 66],
    [-175, 64],
    [-180, 62],
  ],
  [
    [-17, 15],
    [-5, 35],
    [10, 37],
    [32, 31],
    [43, 12],
    [51, 11],
    [40, -15],
    [30, -34],
    [18, -35],
    [12, -5],
    [8, 4],
    [-8, 4],
  ],
  [
    [-168, 66],
    [-140, 70],
    [-95, 72],
    [-80, 63],
    [-60, 55],
    [-66, 45],
    [-80, 25],
    [-97, 18],
    [-87, 13],
    [-105, 20],
    [-117, 32],
    [-125, 48],
    [-150, 60],
    [-165, 60],
  ],
  [
    [-80, 10],
    [-60, 10],
    [-35, -7],
    [-40, -22],
    [-58, -38],
    [-68, -55],
    [-75, -50],
    [-72, -18],
    [-81, -5],
  ],
  [
    [113, -22],
    [130, -12],
    [142, -11],
    [153, -27],
    [146, -39],
    [135, -35],
    [115, -35],
  ],
  // Antarctica reaches the Web Mercator limit (the polar caps beyond it are the surface's).
  [
    [-180, -70],
    [-120, -72],
    [-60, -65],
    [0, -69],
    [60, -67],
    [120, -66],
    [180, -70],
    [180, -85.05],
    [-180, -85.05],
  ],
  [
    [-73, 78],
    [-20, 83],
    [-20, 70],
    [-45, 60],
    [-55, 65],
  ],
];

export const ITALY: Ring = [
  [7, 44],
  [7, 46.4],
  [12, 47],
  [13.7, 45.6],
  [12.4, 44.2],
  [13.6, 43.5],
  [18.5, 40],
  [16, 38],
  [15.6, 40],
  [12, 41.8],
  [10, 44],
];

export function graticule(): GeoFeature[] {
  const out: GeoFeature[] = [];
  for (let lon = -180; lon < 180; lon += 30) {
    const line: [number, number][] = [];
    for (let lat = -85; lat <= 85; lat += 5) line.push([lon, lat]);
    out.push({
      layer: 'boundary',
      minzoom: 0,
      type: 'LineString',
      coordinates: [line],
      properties: { admin_level: 0, class: 'graticule' },
    });
  }
  for (let lat = -60; lat <= 60; lat += 30) {
    // Two halves meeting at the antimeridian, as a tiled line must.
    for (const [from, to] of [
      [-180, 0],
      [0, 180],
    ] as const) {
      const line: [number, number][] = [];
      for (let lon = from; lon <= to; lon += 5) line.push([lon, lat]);
      out.push({
        layer: 'boundary',
        minzoom: 0,
        type: 'LineString',
        coordinates: [line],
        properties: { admin_level: 0, class: 'graticule' },
      });
    }
  }
  return out;
}

const PLACES: readonly [string, number, number, string, number, Record<string, string>?][] = [
  ['Italia', 12.5, 42.8, 'country', 1, { 'name:en': 'Italy', 'name:it': 'Italia' }],
  ['France', 2.5, 46.6, 'country', 1, { 'name:en': 'France', 'name:it': 'Francia' }],
  ['Deutschland', 10.4, 51.1, 'country', 1, { 'name:en': 'Germany', 'name:it': 'Germania' }],
  ['Россия', 60, 60, 'country', 1, { 'name:en': 'Russia', 'name:it': 'Russia' }],
  ['Ελλάδα', 22, 39.5, 'country', 2, { 'name:en': 'Greece', 'name:it': 'Grecia' }],
  ['日本', 138, 37, 'country', 2, { 'name:en': 'Japan', 'name:it': 'Giappone' }],
  ['Roma', 12.5, 41.9, 'city', 1, { 'name:en': 'Rome', 'name:it': 'Roma', capital: '2' }],
  ['Milano', 9.19, 45.464, 'city', 2, { 'name:en': 'Milan', 'name:it': 'Milano' }],
  ['Torino', 7.69, 45.07, 'city', 3, { 'name:en': 'Turin' }],
  ['Napoli', 14.25, 40.85, 'city', 3, { 'name:en': 'Naples' }],
  ['Venezia', 12.33, 45.44, 'city', 3, { 'name:en': 'Venice' }],
  ['Firenze', 11.25, 43.77, 'city', 3, { 'name:en': 'Florence' }],
  ['Genova', 8.93, 44.41, 'city', 4, { 'name:en': 'Genoa' }],
  ['Bologna', 11.34, 44.49, 'city', 4, {}],
  ['Москва', 37.62, 55.75, 'city', 1, { 'name:en': 'Moscow', 'name:it': 'Mosca', capital: '2' }],
  ['Αθήνα', 23.73, 37.98, 'city', 2, { 'name:en': 'Athens', 'name:it': 'Atene', capital: '2' }],
  ['東京', 139.69, 35.69, 'city', 1, { 'name:en': 'Tokyo', 'name:it': 'Tokyo', capital: '2' }],
  ['Paris', 2.35, 48.86, 'city', 1, { 'name:en': 'Paris', 'name:it': 'Parigi', capital: '2' }],
  ['Monza', 9.27, 45.58, 'town', 5, {}],
  ['Bergamo', 9.67, 45.69, 'town', 5, {}],
  ['Como', 9.08, 45.81, 'town', 5, {}],
  ['Pavia', 9.16, 45.19, 'town', 5, {}],
  ['Sesto San Giovanni', 9.23, 45.535, 'town', 6, {}],
  ['Rozzano', 9.16, 45.38, 'village', 7, {}],
  ['Brera', 9.187, 45.472, 'neighbourhood', 8, {}],
  ['Navigli', 9.175, 45.452, 'neighbourhood', 8, {}],
  ['Isola', 9.19, 45.485, 'neighbourhood', 8, {}],
  ['Porta Romana', 9.205, 45.452, 'neighbourhood', 8, {}],
  ['Città Studi', 9.222, 45.476, 'neighbourhood', 8, {}],
];

const PLACE_MINZOOM: Readonly<Record<string, number>> = { country: 0, city: 2, town: 7, village: 9, neighbourhood: 12 };

export function places(): GeoFeature[] {
  return PLACES.map(([name, lon, lat, cls, rank, extra], i) => ({
    layer: 'place',
    minzoom: cls === 'city' && rank > 1 ? 4 : (PLACE_MINZOOM[cls] ?? 0),
    type: 'Point',
    coordinates: [[[lon, lat]]],
    properties: { name, class: cls, rank, ...(extra ?? {}) },
    id: 1000 + i,
  }));
}

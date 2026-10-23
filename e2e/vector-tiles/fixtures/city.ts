// Fixture geography of the street views: a Milan-like city, roads on the fixture peak and latitude towers (ADR 0131).
// Invented data.
import type { GeoFeature, Ring } from './data.ts';
import { ITALY } from './world.ts';

/** Meters to degrees near the city. */
const M_LAT = 1 / 111_320;
const mLon = (lat: number) => 1 / (111_320 * Math.cos((lat * Math.PI) / 180));

const STREET_NAMES = [
  'Via Roma',
  'Via Dante',
  'Corso Garibaldi',
  'Via Torino',
  'Via Manzoni',
  'Via Verdi',
  'Via Brera',
  'Via Solferino',
];

/** Roads as class, minzoom, flat coordinates and properties. */
const ROADS: readonly (readonly [string, number, readonly number[], Record<string, string | number>])[] = [
  // A ring motorway and primary avenues across the center.
  [
    'motorway',
    6,
    [9.152, 45.442, 9.228, 45.442, 9.228, 45.488, 9.152, 45.488, 9.152, 45.442],
    { name: 'Tangenziale', ref: 'A50' },
  ],
  ['primary', 9, [9.152, 45.465, 9.228, 45.465], { name: 'Corso Buenos Aires' }],
  ['primary', 9, [9.19, 45.442, 9.19, 45.488], { name: 'Viale Monza' }],
  // The primary road crossing the canal on a bridge; a minor road below it in a tunnel.
  ['primary', 9, [9.183, 45.447, 9.183, 45.457], { name: 'Ponte di Porta Ticinese', brunnel: 'bridge', layer: 1 }],
  ['minor', 12, [9.176, 45.4505, 9.196, 45.4505], { name: 'Sottopasso', brunnel: 'tunnel', layer: -1 }],
];

const GRID_CLASSES = ['secondary', 'tertiary', 'minor', 'minor', 'service', 'minor', 'tertiary', 'path'];

function pairs(flat: readonly number[]): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < flat.length; i += 2) out.push([flat[i] ?? 0, flat[i + 1] ?? 0]);
  return out;
}

/** A grid of streets of the lesser classes, every one named. */
function gridRoads(): (typeof ROADS)[number][] {
  const out: (typeof ROADS)[number][] = [];
  for (let i = 0; i < 8; i++) {
    const lat = 45.447 + i * 0.005;
    const cls = GRID_CLASSES[i] ?? 'minor';
    if (Math.abs(lat - 45.465) > 0.001)
      out.push([
        cls,
        cls === 'path' || cls === 'service' ? 13 : 11,
        [9.155, lat, 9.225, lat],
        { name: STREET_NAMES[i] ?? 'Via' },
      ]);
    const lon = 9.158 + i * 0.009;
    out.push([
      GRID_CLASSES[(i + 3) % 8] ?? 'minor',
      11,
      [lon, 45.444, lon, 45.486],
      { name: `Via ${String.fromCharCode(65 + i)}` },
    ]);
  }
  // A curved avenue, for labels along curves (F449).
  const arc: number[] = [];
  for (let a = 0; a <= 180; a += 6) {
    const rad = (a * Math.PI) / 180;
    arc.push(9.19 + Math.cos(rad) * 900 * mLon(45.47), 45.47 + Math.sin(rad) * 900 * M_LAT);
  }
  out.push(['secondary', 11, arc, { name: 'Viale delle Rimembranze' }]);
  return out;
}

/** The city's roads and its canal. */
export function cityRoads(): GeoFeature[] {
  const roads = [...ROADS, ...gridRoads()].map(([cls, minzoom, flat, extra], i): GeoFeature => ({
    layer: 'transportation',
    minzoom,
    type: 'LineString',
    coordinates: [pairs(flat)],
    properties: { class: cls, ...extra },
    id: 5000 + i,
  }));
  const canal: GeoFeature = {
    layer: 'waterway',
    minzoom: 10,
    type: 'LineString',
    coordinates: [pairs([9.16, 45.452, 9.21, 45.452])],
    properties: { class: 'canal', name: 'Naviglio Grande' },
  };
  return [...roads, canal];
}

function box(lon: number, lat: number, wM: number, hM: number): Ring {
  const dx = (wM / 2) * mLon(lat);
  const dy = (hM / 2) * M_LAT;
  // Clockwise on screen in tile space (y down) is counterclockwise in lon/lat: exterior rings run this way.
  return [
    [lon - dx, lat - dy],
    [lon + dx, lat - dy],
    [lon + dx, lat + dy],
    [lon - dx, lat + dy],
    [lon - dx, lat - dy],
  ];
}

/** Building types without height tags, with the defaults of `docs/guides/data-layers.md` (F456). */
const UNTAGGED_TYPES = ['house', 'apartments', 'commercial', 'industrial', 'church', 'garage'] as const;

export function cityBuildings(): GeoFeature[] {
  const out: GeoFeature[] = [];
  const building = (ring: Ring, properties: Record<string, string | number>, id: number) =>
    out.push({ layer: 'building', minzoom: 13, type: 'Polygon', coordinates: [ring], properties, id });
  let id = 20_000;
  for (let i = 0; i < 7; i++) {
    for (let j = 0; j < 7; j++) {
      const lon = 9.1625 + j * 0.009;
      const lat = 45.4495 + i * 0.005;
      const k = (i * 7 + j) % 4;
      const tags: Record<string, string | number>[] = [
        { building: 'apartments', height: 18 + ((i + j) % 5) * 6 },
        { building: 'commercial', 'building:levels': 3 + ((i * j) % 6) },
        // Every fourth building is untagged; they cycle through the types in order.
        { building: UNTAGGED_TYPES[Math.floor((i * 7 + j) / 4) % UNTAGGED_TYPES.length] ?? 'house' },
        { building: 'yes', height: 30, min_height: 10 },
      ];
      building(box(lon, lat, 120, 90), tags[k] ?? {}, id++);
    }
  }
  // Known buildings for F455: an outline with two parts (the outline is hidden by them).
  building(box(9.2, 45.4605, 80, 80), { building: 'office', height: 60 }, 29_000);
  building(box(9.2 - 20 * mLon(45.46), 45.4605, 40, 80), { 'building:part': 'yes', height: 80, min_height: 0 }, 29_001);
  building(
    box(9.2 + 20 * mLon(45.46), 45.4605, 40, 80),
    { 'building:part': 'yes', height: 40, min_height: 12 },
    29_002,
  );
  return out;
}

export function waterAndParks(): GeoFeature[] {
  return [
    {
      layer: 'water',
      minzoom: 10,
      type: 'Polygon',
      coordinates: [box(9.185, 45.452, 4000, 40)],
      properties: { class: 'river' },
    },
    {
      layer: 'landuse',
      minzoom: 10,
      type: 'Polygon',
      coordinates: [box(9.176, 45.473, 700, 600)],
      properties: { class: 'park', name: 'Parco Sempione' },
    },
    {
      layer: 'landcover',
      minzoom: 0,
      type: 'Polygon',
      coordinates: [ITALY],
      properties: { class: 'country', subclass: 'italy' },
    },
  ];
}

export function mountainRoads(): GeoFeature[] {
  // A switchback road up the fixture peak and a ring road around it (F452).
  const up: [number, number][] = [];
  for (let k = 0; k <= 12; k++) up.push([6.82 + (k % 2) * 0.08, 45.67 + k * 0.005]);
  const ring: [number, number][] = [];
  for (let a = 0; a <= 360; a += 10)
    ring.push([6.86 + 0.04 * Math.cos((a * Math.PI) / 180), 45.7 + 0.025 * Math.sin((a * Math.PI) / 180)]);
  return [
    {
      layer: 'transportation',
      minzoom: 10,
      type: 'LineString',
      coordinates: [up],
      properties: { class: 'secondary', name: 'Strada del Colle' },
    },
    {
      layer: 'transportation',
      minzoom: 10,
      type: 'LineString',
      coordinates: [ring],
      properties: { class: 'primary', name: 'Anello' },
    },
  ];
}

/** Towers 100 m tall, 40 m wide, at latitudes 0, 45 and 60 degrees (F458). */
const TOWERS: readonly { readonly lat: number; readonly heightMeters: number }[] = [
  { lat: 0, heightMeters: 100 },
  { lat: 45, heightMeters: 100 },
  { lat: 60, heightMeters: 100 },
];

export function towers(): GeoFeature[] {
  return TOWERS.map((t, i) => ({
    layer: 'building',
    minzoom: 13,
    type: 'Polygon',
    coordinates: [box(10, t.lat, 40, 40)],
    properties: { building: 'yes', height: t.heightMeters },
    id: 30_000 + i,
  }));
}

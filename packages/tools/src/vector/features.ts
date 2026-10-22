/**
 * Which OpenStreetMap objects become vector-tile features (F341): roads, places and buildings, each with the lowest
 * zoom at which it appears and the attributes the engine uses (building height and levels where present).
 */
import type { OsmNode, OsmWay } from './osm-pbf.js';

/** Geometry types of MVT. */
type GeometryType = 'point' | 'line' | 'polygon';

/** A feature in geographic coordinates, ready for tiling. */
export interface VectorFeature {
  id: number;
  layer: 'roads' | 'places' | 'buildings';
  type: GeometryType;
  /** `[lonDeg, latDeg]` pairs: one point, a line, or a closed outer ring. */
  coordinates: [number, number][];
  properties: Record<string, string | number>;
  minZoom: number;
}

const ROAD_MIN_ZOOM: Record<string, number> = {
  motorway: 5,
  trunk: 5,
  primary: 8,
  secondary: 9,
  tertiary: 10,
  motorway_link: 10,
  trunk_link: 10,
  primary_link: 11,
  unclassified: 12,
  residential: 12,
  living_street: 13,
  service: 13,
  pedestrian: 13,
  track: 13,
  footway: 14,
  cycleway: 14,
  path: 14,
  steps: 14,
};
const PLACE_MIN_ZOOM: Record<string, number> = {
  country: 0,
  state: 4,
  city: 4,
  town: 7,
  village: 10,
  suburb: 11,
  hamlet: 12,
  neighbourhood: 13,
  locality: 13,
};
/** Buildings appear from this zoom. */
const BUILDING_MIN_ZOOM = 13;

/** Parses an OSM length (`12`, `12.5 m`, `40'`) into meters, or `undefined`. */
export function parseMeters(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const match = /^\s*(-?\d+(?:[.,]\d+)?)\s*(m|ft|')?\s*$/.exec(value);
  if (!match) return undefined;
  const number = Number((match[1] ?? '').replace(',', '.'));
  return match[2] === 'ft' || match[2] === "'" ? Math.round(number * 0.3048 * 100) / 100 : number;
}

function named(
  tags: Record<string, string>,
  properties: Record<string, string | number>,
): Record<string, string | number> {
  if (tags['name']) properties['name'] = tags['name'];
  return properties;
}

/** The place feature of a node, if it is one. */
export function placeFeature(node: OsmNode): VectorFeature | undefined {
  const place = node.tags['place'];
  const minZoom = place === undefined ? undefined : PLACE_MIN_ZOOM[place];
  if (minZoom === undefined) return undefined;
  const properties = named(node.tags, { class: place ?? '' });
  const population = Number(node.tags['population']);
  if (Number.isFinite(population) && population > 0) properties['population'] = population;
  return { id: node.id, layer: 'places', type: 'point', coordinates: [[node.lon, node.lat]], properties, minZoom };
}

/** Whether a way can become a feature (decides which nodes must be kept). */
export function wantedWay(way: OsmWay): boolean {
  const highway = way.tags['highway'];
  if (highway !== undefined && ROAD_MIN_ZOOM[highway] !== undefined && way.tags['area'] !== 'yes') return true;
  return (
    way.tags['building'] !== undefined && way.tags['building'] !== 'no' && way.refs[0] === way.refs[way.refs.length - 1]
  );
}

/** The road or building feature of a way with its resolved coordinates. */
export function wayFeature(way: OsmWay, coordinates: [number, number][]): VectorFeature | undefined {
  const highway = way.tags['highway'];
  const roadZoom = highway === undefined ? undefined : ROAD_MIN_ZOOM[highway];
  if (roadZoom !== undefined && way.tags['area'] !== 'yes') {
    const properties = named(way.tags, { class: highway ?? '' });
    if (way.tags['ref']) properties['ref'] = way.tags['ref'];
    return { id: way.id, layer: 'roads', type: 'line', coordinates, properties, minZoom: roadZoom };
  }
  if (!wantedWay(way) || coordinates.length < 4) return undefined;
  const properties: Record<string, string | number> = { building: way.tags['building'] ?? 'yes' };
  const height = parseMeters(way.tags['height']);
  const minHeight = parseMeters(way.tags['min_height']);
  const levels = Number(way.tags['building:levels']);
  if (height !== undefined) properties['height'] = height;
  if (minHeight !== undefined) properties['min_height'] = minHeight;
  if (Number.isFinite(levels) && way.tags['building:levels'] !== undefined) properties['levels'] = levels;
  return {
    id: way.id,
    layer: 'buildings',
    type: 'polygon',
    coordinates,
    properties: named(way.tags, properties),
    minZoom: BUILDING_MIN_ZOOM,
  };
}

/** The field types of each layer, as TileJSON `vector_layers` lists them. */
export const VECTOR_LAYERS = [
  { id: 'roads', fields: { class: 'String', name: 'String', ref: 'String' } },
  { id: 'places', fields: { class: 'String', name: 'String', population: 'Number' } },
  {
    id: 'buildings',
    fields: { building: 'String', height: 'Number', min_height: 'Number', levels: 'Number', name: 'String' },
  },
];

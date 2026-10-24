// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * OpenStreetMap roads and places for vector-tile styles (F453, F454; ADR 0041). Works with raw OpenStreetMap tags
 * (`highway`, `bridge`, `tunnel`, `layer`, `place`, `name:xx`) and the OpenMapTiles schema the data pipeline writes
 * (`class`, `brunnel`, `layer`, `rank`, `capital`, `name:xx` and `name_xx`).
 */

/** Road classes from the most to the least important (OpenMapTiles `class` values and raw `highway` values). */
export const ROAD_CLASSES = [
  'motorway',
  'trunk',
  'primary',
  'secondary',
  'tertiary',
  'minor',
  'service',
  'track',
  'path',
] as const;

/** A road class. */
export type RoadClass = (typeof ROAD_CLASSES)[number];

const HIGHWAY_TO_CLASS: Readonly<Record<string, RoadClass>> = {
  motorway: 'motorway',
  motorway_link: 'motorway',
  trunk: 'trunk',
  trunk_link: 'trunk',
  primary: 'primary',
  primary_link: 'primary',
  secondary: 'secondary',
  secondary_link: 'secondary',
  tertiary: 'tertiary',
  tertiary_link: 'tertiary',
  residential: 'minor',
  unclassified: 'minor',
  living_street: 'minor',
  road: 'minor',
  minor: 'minor',
  service: 'service',
  track: 'track',
  path: 'path',
  footway: 'path',
  cycleway: 'path',
  bridleway: 'path',
  steps: 'path',
  pedestrian: 'path',
};

/** The road class of a feature, or undefined for features that are not roads. */
export function roadClass(properties: Readonly<Record<string, unknown>>): RoadClass | undefined {
  const value = String(properties['class'] ?? properties['highway'] ?? '');
  return HIGHWAY_TO_CLASS[value];
}

/** Whether a road is a bridge, a tunnel or at ground level. */
export function brunnel(properties: Readonly<Record<string, unknown>>): 'bridge' | 'tunnel' | 'ground' {
  const value = properties['brunnel'];
  if (value === 'bridge' || value === 'tunnel') return value;
  const yes = (v: unknown): boolean => v !== undefined && v !== 'no' && v !== false && v !== 0;
  if (yes(properties['bridge'])) return 'bridge';
  if (yes(properties['tunnel'])) return 'tunnel';
  return 'ground';
}

/**
 * The draw order of a road (higher draws later, on top): tunnels below ground roads below bridges, then the `layer`
 * tag, then the class with the most important roads on top. Use it as the sort key of line layers (`line-sort-key`)
 * or to order buckets.
 */
export function roadDrawOrder(properties: Readonly<Record<string, unknown>>): number {
  const level = { tunnel: 0, ground: 1, bridge: 2 }[brunnel(properties)];
  const layerTag = Math.max(-5, Math.min(5, Math.trunc(Number(properties['layer'] ?? 0)) || 0));
  const cls = roadClass(properties);
  const importance = cls === undefined ? 0 : ROAD_CLASSES.length - ROAD_CLASSES.indexOf(cls);
  return level * 1000 + (layerTag + 5) * 20 + importance;
}

/** Place classes from the most to the least important. */
export const PLACE_CLASSES = [
  'continent',
  'country',
  'state',
  'province',
  'city',
  'town',
  'village',
  'hamlet',
  'suburb',
  'quarter',
  'neighbourhood',
  'isolated_dwelling',
] as const;

/**
 * The placement priority of a place label (the `symbol-sort-key`: lower is placed first): class, then capital status,
 * then the OpenMapTiles `rank`, then population. Capitals and large cities therefore win over smaller places.
 */
export function placePriority(properties: Readonly<Record<string, unknown>>): number {
  const cls = String(properties['class'] ?? properties['place'] ?? '');
  const classIndex = PLACE_CLASSES.indexOf(cls as (typeof PLACE_CLASSES)[number]);
  const classRank = classIndex < 0 ? PLACE_CLASSES.length : classIndex;
  const capitalTag = properties['capital'];
  const capital = capitalTag === 'yes' ? 2 : Number(capitalTag ?? 0) || 0;
  const capitalRank = capital === 2 ? 0 : capital > 0 ? 1 : 2;
  const rank = Math.max(0, Math.min(99, Number(properties['rank'] ?? 50) || 50));
  const population = Math.max(0, Number(properties['population'] ?? 0) || 0);
  const populationRank = 1 - Math.min(1, Math.log10(population + 1) / 8);
  return classRank * 1000 + capitalRank * 300 + rank * 2 + populationRank;
}

/** The label text in `language` (`name:xx`, then OpenMapTiles' `name_xx`), falling back to `name`. */
export function localizedName(properties: Readonly<Record<string, unknown>>, language: string): string | undefined {
  for (const key of [`name:${language}`, `name_${language}`, 'name']) {
    const value = properties[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/** A `text-field` expression with the same fallback, for styles: `['coalesce', ['get', 'name:it'], …]`. */
export function localizedTextField(language: string): unknown[] {
  return ['coalesce', ['get', `name:${language}`], ['get', `name_${language}`], ['get', 'name']];
}

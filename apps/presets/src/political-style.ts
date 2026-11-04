// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * The Europe preset's political map (Map and Relief): written here on the data of an OpenMapTiles-schema style
 * (OpenFreeMap's), like Google Maps' default map. One neutral land color with no land cover (no forests, parks, fields
 * or land use), blue water, the borders of countries and of their regions, and place and water names; roads are an
 * overlay of their own. The source, glyphs and fonts are the given style's.
 */
import type { StyleJson, StyleLayerJson } from './styles.js';

/** The political map's colors; the polar caps of Map and Relief take the land's and the water's. */
export const POLITICAL_COLORS = {
  land: '#f2efe9',
  water: '#a9cfe8',
  border: '#8c8094',
  regionBorder: '#b5aabb',
  text: '#3f3b38',
  waterText: '#4a76a1',
  halo: '#ffffff',
} as const;

/** The parts of the political map, drawn bottom first with the relief and the overlays between them. */
export interface PoliticalParts {
  /** The land color. */
  readonly background: readonly StyleLayerJson[];
  /** Seas, lakes and rivers: above the relief, which never shades the water. */
  readonly water: readonly StyleLayerJson[];
  /** Country and region borders: above the roads. */
  readonly borders: readonly StyleLayerJson[];
  /** Place and water names: on top. */
  readonly labels: readonly StyleLayerJson[];
}

/** The style's vector source in the OpenMapTiles schema: the source of its water or place layers. */
export function vectorSourceOf(style: StyleJson): string | undefined {
  const layer = style.layers.find((l) => l['source-layer'] === 'water' || l['source-layer'] === 'place');
  return layer?.source ?? Object.keys(style.sources).find((id) => style.sources[id]?.['type'] === 'vector');
}

/** A font of the style's names in a face (`Regular`, `Bold`, `Italic`), so the glyphs it serves are the ones asked for. */
export type FontFace = 'Regular' | 'Bold' | 'Italic';

/**
 * The style's name font in `face` (KB-243: the first place layer's font is often its italic one), else its first name
 * font, else Noto Sans in that face.
 */
export function fontOf(style: StyleJson, face: FontFace = 'Regular'): readonly string[] {
  const fonts: string[][] = [];
  for (const layer of style.layers) {
    const font = (layer['layout'] as Record<string, unknown> | undefined)?.['text-font'];
    const names = layer['source-layer'] === 'place' || layer['source-layer'] === 'water_name';
    if (names && Array.isArray(font) && font.every((f) => typeof f === 'string')) fonts.push(font as string[]);
  }
  return fonts.find((font) => font.some((name) => name.includes(face))) ?? fonts[0] ?? [`Noto Sans ${face}`];
}

/**
 * A place or water name label, haloed in white unless `halo` says otherwise, in `language` where the tiles name it so
 * (`name:<language>`), else in its Latin or local name.
 */
export function nameLayer(
  id: string,
  source: string,
  sourceLayer: string,
  classes: readonly string[],
  options: {
    font: readonly string[];
    size: unknown;
    color: string;
    minzoom: number;
    maxzoom?: number;
    rank?: number;
    halo?: string;
    language?: string | undefined;
  },
): StyleLayerJson {
  return {
    id,
    type: 'symbol',
    source,
    'source-layer': sourceLayer,
    minzoom: options.minzoom,
    ...(options.maxzoom === undefined ? {} : { maxzoom: options.maxzoom }),
    filter: ['match', ['get', 'class'], [...classes], true, false],
    layout: {
      'text-field': options.language
        ? ['coalesce', ['get', `name:${options.language}`], ['get', 'name:latin'], ['get', 'name']]
        : ['coalesce', ['get', 'name'], ['get', 'name:latin']],
      'text-font': [...options.font],
      'text-size': options.size,
      'text-max-width': 8,
      'symbol-sort-key': ['coalesce', ['get', 'rank'], options.rank ?? 10],
    },
    paint: {
      'text-color': options.color,
      'text-halo-color': options.halo ?? POLITICAL_COLORS.halo,
      'text-halo-width': 1.4,
    },
  };
}

/** A border line of an administrative level, maritime borders left out. */
export function borderLayer(
  id: string,
  source: string,
  level: number,
  paint: Record<string, unknown>,
  minzoom: number,
): StyleLayerJson {
  return {
    id,
    type: 'line',
    source,
    'source-layer': 'boundary',
    minzoom,
    filter: ['all', ['==', ['get', 'admin_level'], level], ['!=', ['get', 'maritime'], 1]],
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint,
  };
}

/** A value interpolated linearly by zoom through `stops` (zoom, value, zoom, value, …). */
export const zoomed = (stops: number[]): unknown[] => ['interpolate', ['linear'], ['zoom'], ...stops];

/** Seas, lakes and rivers. */
function waterLayers(source: string): StyleLayerJson[] {
  return [
    {
      id: 'political-water',
      type: 'fill',
      source,
      'source-layer': 'water',
      filter: ['!=', ['get', 'brunnel'], 'tunnel'],
      paint: { 'fill-color': POLITICAL_COLORS.water },
    },
    {
      id: 'political-rivers',
      type: 'line',
      source,
      'source-layer': 'waterway',
      minzoom: 8,
      filter: ['match', ['get', 'class'], ['river', 'canal'], true, false],
      paint: { 'line-color': POLITICAL_COLORS.water, 'line-width': zoomed([8, 0.6, 14, 3]) },
    },
  ];
}

/** Region borders (dashed) below country borders. */
function borderLayers(source: string): StyleLayerJson[] {
  const regions = { 'line-color': POLITICAL_COLORS.regionBorder, 'line-width': zoomed([3, 0.5, 10, 1.4]) };
  return [
    borderLayer('political-region-borders', source, 4, { ...regions, 'line-dasharray': [3, 2] }, 3),
    borderLayer(
      'political-country-borders',
      source,
      2,
      { 'line-color': POLITICAL_COLORS.border, 'line-width': zoomed([0, 0.6, 6, 1.4, 12, 2.4]) },
      0,
    ),
  ];
}

/** Water names, then places from villages to countries (the larger drawn last, on top). */
function nameLayers(source: string, font: (face: FontFace) => readonly string[], language?: string): StyleLayerJson[] {
  const text = POLITICAL_COLORS.text;
  const place = (id: string, classes: string[], size: number[], minzoom: number, rank: number, maxzoom?: number) =>
    nameLayer(id, source, 'place', classes, {
      font: font(id === 'political-countries' ? 'Bold' : 'Regular'),
      size: zoomed(size),
      color: id === 'political-regions' ? '#7a6f80' : text,
      minzoom,
      rank,
      language,
      ...(maxzoom === undefined ? {} : { maxzoom }),
    });
  return [
    nameLayer('political-water-names', source, 'water_name', ['ocean', 'sea', 'lake', 'bay', 'strait'], {
      font: font('Italic'),
      size: zoomed([2, 10, 8, 14]),
      color: POLITICAL_COLORS.waterText,
      minzoom: 2,
      language,
    }),
    place('political-villages', ['village'], [11, 10, 15, 13], 11, 30),
    place('political-towns', ['town'], [8, 10, 14, 15], 8, 20),
    place('political-cities', ['city'], [4, 11, 10, 17], 4, 5),
    place('political-regions', ['state', 'province'], [4, 10, 8, 13], 4, 3, 9),
    place('political-countries', ['country'], [1, 10, 6, 16], 1, 1, 8),
  ];
}

/** The political map's layers on the style's data; undefined when the style has no OpenMapTiles vector source. */
export function politicalParts(style: StyleJson, language?: string): PoliticalParts | undefined {
  const source = vectorSourceOf(style);
  if (source === undefined) return undefined;
  return {
    background: [{ id: 'political-land', type: 'background', paint: { 'background-color': POLITICAL_COLORS.land } }],
    water: waterLayers(source),
    borders: borderLayers(source),
    labels: nameLayers(source, (face) => fontOf(style, face), language),
  };
}

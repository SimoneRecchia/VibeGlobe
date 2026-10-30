// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * The Europe preset's Landscape map (F644), like a virtual globe's map: land in soft greens and whites by its cover
 * (forests, open land, fields, bare rock, sand, ice), light blue water and a light hillshade, with no borders, names or
 * roads, which are overlays of their own (F645). The vector tiles hold land cover from level 7: farther away the app's
 * land cover image shows under the water (`EuropeOpenOptions.landCover`), and the land color covers it from level 7 to
 * 8; without one the land is one color there. The borders, country and sea names overlays draw over this map and over
 * the imagery alike, in dark ink on the map and light ink on the imagery.
 */
import { borderLayer, fontOf, nameLayer, vectorSourceOf, zoomed } from './political-style.js';
import type { StyleJson, StyleLayerJson, StyleSelection } from './styles.js';

/** The Landscape map's colors; its polar caps take the water's and the ice's. */
export const LANDSCAPE_COLORS = {
  land: '#ecf5ee',
  forest: '#b4e4c6',
  grass: '#cceed8',
  field: '#dcf3e3',
  bare: '#f2f3f0',
  sand: '#f6f3e6',
  ice: '#fcfdfd',
  urban: '#eaecec',
  water: '#8ad3e9',
} as const;

/** OpenMapTiles land cover classes, by the color each takes. */
const COVER: readonly (readonly [string, keyof typeof LANDSCAPE_COLORS])[] = [
  ['wood', 'forest'],
  ['grass', 'grass'],
  ['wetland', 'grass'],
  ['farmland', 'field'],
  ['rock', 'bare'],
  ['sand', 'sand'],
  ['ice', 'ice'],
];
const URBAN_CLASSES = ['residential', 'suburb', 'neighbourhood', 'industrial', 'commercial', 'retail'];
/** Where the tiles' own land cover takes over from the app's land cover image. */
const COVER_FADE = [7, 0, 8, 1];

/** The Landscape map's layers below the overlays: land, its cover, the hillshade, then the water. */
export function landscapeLayers(
  style: StyleJson,
  farImage: boolean,
  hillshade: StyleLayerJson | undefined,
): StyleLayerJson[] {
  const source = vectorSourceOf(style);
  const fade = farImage ? zoomed(COVER_FADE) : 1;
  const background: StyleLayerJson = {
    id: 'landscape-land',
    type: 'background',
    paint: { 'background-color': LANDSCAPE_COLORS.land, 'background-opacity': fade },
  };
  if (source === undefined) return [background, ...(hillshade ? [hillshade] : [])];
  const fill = (
    id: string,
    sourceLayer: string,
    classes: string[],
    color: string,
    minzoom: number,
  ): StyleLayerJson => ({
    id,
    type: 'fill',
    source,
    'source-layer': sourceLayer,
    minzoom,
    filter: ['match', ['get', 'class'], classes, true, false],
    paint: { 'fill-color': color, 'fill-opacity': fade },
  });
  return [
    background,
    ...COVER.map(([cls, color]) =>
      fill(`landscape-${cls}`, 'landcover', [cls], LANDSCAPE_COLORS[color], cls === 'ice' ? 0 : 7),
    ),
    fill('landscape-urban', 'landuse', URBAN_CLASSES, LANDSCAPE_COLORS.urban, 9),
    ...(hillshade ? [hillshade] : []),
    {
      id: 'landscape-water',
      type: 'fill',
      source,
      'source-layer': 'water',
      filter: ['!=', ['get', 'brunnel'], 'tunnel'],
      paint: { 'fill-color': LANDSCAPE_COLORS.water },
    },
    {
      id: 'landscape-rivers',
      type: 'line',
      source,
      'source-layer': 'waterway',
      minzoom: 8,
      filter: ['match', ['get', 'class'], ['river', 'canal'], true, false],
      paint: { 'line-color': LANDSCAPE_COLORS.water, 'line-width': zoomed([8, 0.6, 14, 3]) },
    },
  ];
}

/** The ink of the overlays: dark on a map, light on imagery. */
const INK = {
  map: { border: '#5d5864', region: '#9b96a1', text: '#2f2c33', sea: '#3d7ea6', halo: '#ffffff' },
  imagery: {
    border: '#ffffff',
    region: 'rgba(255, 255, 255, 0.7)',
    text: '#ffffff',
    sea: '#ffffff',
    halo: 'rgba(0, 0, 0, 0.6)',
  },
} as const;

/**
 * The borders, country names and sea names overlays (F645): country borders at every level and region borders only
 * from level 5, the finer administrative levels never; country names to level 8; ocean and sea names.
 */
export function labelOverlays(style: StyleJson, selection: StyleSelection, onImagery: boolean): StyleLayerJson[] {
  const source = vectorSourceOf(style);
  if (source === undefined) return [];
  const ink = onImagery ? INK.imagery : INK.map;
  const layers: StyleLayerJson[] = [];
  if (selection.borders === true)
    layers.push(
      borderLayer(
        'overlay-region-borders',
        source,
        4,
        { 'line-color': ink.region, 'line-width': zoomed([5, 0.5, 10, 1.2]), 'line-dasharray': [3, 2] },
        5,
      ),
      borderLayer(
        'overlay-country-borders',
        source,
        2,
        { 'line-color': ink.border, 'line-width': zoomed([0, 0.6, 6, 1.3, 12, 2.2]) },
        0,
      ),
    );
  if (selection.seas === true)
    layers.push(
      nameLayer('overlay-sea-names', source, 'water_name', ['ocean', 'sea'], {
        font: fontOf(style, 'Italic'),
        size: zoomed([2, 10, 8, 14]),
        color: ink.sea,
        minzoom: 2,
        halo: ink.halo,
        language: selection.language,
      }),
    );
  if (selection.countries === true)
    layers.push(
      nameLayer('overlay-country-names', source, 'place', ['country'], {
        font: fontOf(style, 'Bold'),
        size: zoomed([1, 10, 6, 16]),
        color: ink.text,
        minzoom: 1,
        maxzoom: 8,
        rank: 1,
        halo: ink.halo,
        language: selection.language,
      }),
    );
  return layers;
}

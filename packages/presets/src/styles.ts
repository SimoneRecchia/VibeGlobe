// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * The vector styles of the Europe preset's map types, derived from one OpenStreetMap style in the OpenMapTiles schema
 * (OpenFreeMap's): a political map of its data for the Map (`political-style.ts`), its labels and borders, roads and
 * buildings as overlays, and for Relief the political map over a light hypsometric tint and a hillshade of the terrain.
 * One composed style per selection, so the tiles shared by its parts load once.
 */
import { labelOverlays, landscapeLayers } from './landscape-style.js';
import { POLITICAL_COLORS, politicalParts } from './political-style.js';

/** A MapLibre style, as far as the preset reads and writes it. */
export interface StyleJson {
  readonly version: number;
  readonly sources: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly layers: readonly StyleLayerJson[];
  readonly glyphs?: string;
  readonly sprite?: unknown;
  readonly [key: string]: unknown;
}

/** A style layer, as far as the preset reads it. */
export interface StyleLayerJson {
  readonly id: string;
  readonly type: string;
  readonly source?: string;
  readonly 'source-layer'?: string;
  readonly [key: string]: unknown;
}

/** The parts of a composed style. */
export interface StyleSelection {
  /** The political map (Map, and Relief's base): neutral land, water, borders and names, drawn over everything below. */
  readonly map?: boolean;
  /** Place, water and peak names, and borders. */
  readonly labels?: boolean;
  /** Roads, railways and their names. */
  readonly roads?: boolean;
  /** Buildings, extruded to their heights. */
  readonly buildings?: boolean;
  /** A light hypsometric tint and a hillshade of the terrain (Relief); a lighter hillshade alone on the Landscape. */
  readonly hillshade?: boolean;
  /** The Landscape map (F644): land by its cover, light blue water. */
  readonly landscape?: boolean;
  /** The app's land cover image is under the Landscape map far away: its land color fades in from level 7 to 8. */
  readonly landCoverImage?: boolean;
  /** Country borders, and region borders from level 5 (F645); over imagery and the Landscape. */
  readonly borders?: boolean;
  /** Country names (F645); over imagery and the Landscape. */
  readonly countries?: boolean;
  /** Ocean and sea names (F645); over imagery and the Landscape. */
  readonly seas?: boolean;
  /** Names in this language where the tiles have it (`name:<language>`, such as `it`), else Latin or local (F645). */
  readonly language?: string | undefined;
}

/** OpenMapTiles source layers of each overlay. */
const LABEL_LAYERS = new Set(['place', 'water_name', 'mountain_peak', 'boundary', 'aerodrome_label']);
const ROAD_LAYERS = new Set(['transportation', 'transportation_name']);

/**
 * The road classes (OpenMapTiles `class`) shown from each level (F626): motorways from 6, trunk and primary roads from
 * 9, secondary and tertiary from 11, minor roads from 13 and everything else (service roads, tracks, paths, railways)
 * from 14; road names from 13.
 */
const ROAD_CLASS_BY_LEVEL: readonly (readonly [number, readonly string[]])[] = [
  [6, ['motorway']],
  [9, ['motorway', 'trunk', 'primary']],
  [11, ['motorway', 'trunk', 'primary', 'secondary', 'tertiary']],
  [13, ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor']],
];
const FIRST_ROAD_LEVEL = 6;
const ALL_ROADS_LEVEL = 14;
const ROAD_NAMES_LEVEL = 13;

/** A road layer of the style that shows each class only from its level, and road names only from 13 (F626). */
function progressiveRoads(layer: StyleLayerJson): StyleLayerJson {
  const minzoom = typeof layer['minzoom'] === 'number' ? layer['minzoom'] : 0;
  if (layer['source-layer'] === 'transportation_name')
    return { ...layer, minzoom: Math.max(minzoom, ROAD_NAMES_LEVEL) };
  const classes = (list: readonly string[]): unknown[] => ['match', ['get', 'class'], [...list], true, false];
  const byLevel: unknown[] = ['step', ['zoom'], classes(ROAD_CLASS_BY_LEVEL[0]?.[1] ?? [])];
  for (const [level, list] of ROAD_CLASS_BY_LEVEL.slice(1)) byLevel.push(level, classes(list));
  byLevel.push(ALL_ROADS_LEVEL, true);
  const filter = layer['filter'] === undefined ? byLevel : ['all', layer['filter'], byLevel];
  return { ...layer, minzoom: Math.max(minzoom, FIRST_ROAD_LEVEL), filter };
}

/** The terrain tiles of the hillshade. */
export interface HillshadeSource {
  readonly tiles: readonly string[];
  readonly maxzoom: number;
  readonly tileSize: number;
  readonly attribution: string;
}

const HILLSHADE_SOURCE = 'europe-hillshade';

function overlayLayers(style: StyleJson, selection: StyleSelection): StyleLayerJson[] {
  const out: StyleLayerJson[] = [];
  for (const layer of style.layers) {
    const sourceLayer = layer['source-layer'] ?? '';
    const wanted =
      (selection.labels === true && LABEL_LAYERS.has(sourceLayer)) ||
      (selection.roads === true && ROAD_LAYERS.has(sourceLayer)) ||
      (selection.buildings === true && sourceLayer === 'building' && layer.type === 'fill-extrusion');
    if (wanted) out.push(ROAD_LAYERS.has(sourceLayer) ? progressiveRoads(layer) : layer);
  }
  if (selection.buildings === true && !out.some((l) => l.type === 'fill-extrusion')) {
    // A style without extruded buildings: extrude OpenMapTiles' footprints to their heights.
    const source = style.layers.find((l) => l['source-layer'] === 'building')?.source;
    if (source !== undefined)
      out.push({
        id: 'europe-buildings-3d',
        type: 'fill-extrusion',
        source,
        'source-layer': 'building',
        minzoom: 14,
        paint: {
          'fill-extrusion-color': '#d9d0c9',
          'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 10],
          'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
          'fill-extrusion-opacity': 0.85,
        },
      });
  }
  return out;
}

/** The relief: a light tint by elevation (lowlands green, uplands tan, high mountains pale) and a hillshade. */
function reliefLayers(): StyleLayerJson[] {
  return [
    {
      id: 'europe-relief-tint',
      type: 'color-relief',
      source: HILLSHADE_SOURCE,
      paint: {
        'color-relief-opacity': 0.55,
        'color-relief-color': [
          'interpolate',
          ['linear'],
          ['elevation'],
          0,
          '#d5e6c1',
          300,
          '#e4ecc5',
          800,
          '#ede3bf',
          1500,
          '#e0cba3',
          2500,
          '#d6c2a8',
          3500,
          '#ece6df',
          4500,
          '#ffffff',
        ],
      },
    },
    {
      id: 'europe-hillshade',
      type: 'hillshade',
      source: HILLSHADE_SOURCE,
      paint: { 'hillshade-exaggeration': 0.5, 'hillshade-shadow-color': '#473b24' },
    },
  ];
}

/**
 * The Landscape's hillshade: lighter than the Relief's, with no tint, and only far away (KB-242): nearer, the 3D
 * terrain shows the relief, and a tilted view would shade hundreds of DEM tiles on the CPU.
 */
const LANDSCAPE_HILLSHADE: StyleLayerJson = {
  id: 'landscape-hillshade',
  type: 'hillshade',
  source: HILLSHADE_SOURCE,
  maxzoom: 11,
  paint: {
    'hillshade-exaggeration': 0.2,
    'hillshade-shadow-color': '#6d7d73',
    'hillshade-highlight-color': '#ffffff',
  },
};

/** The Landscape bottom first: land, roads, borders, buildings, then names on top. */
function landscapeSelection(style: StyleJson, selection: StyleSelection, relief: boolean): StyleLayerJson[] {
  const overlays = overlayLayers(style, selection);
  const labels = labelOverlays(style, selection, false);
  return [
    ...landscapeLayers(style, selection.landCoverImage === true, relief ? LANDSCAPE_HILLSHADE : undefined),
    ...overlays.filter((l) => l.type !== 'fill-extrusion'),
    ...labels.filter((l) => l.type === 'line'),
    ...overlays.filter((l) => l.type === 'fill-extrusion'),
    ...labels.filter((l) => l.type !== 'line'),
  ];
}

/** The raster-dem source of the relief. */
function reliefSource(hillshade: HillshadeSource): Readonly<Record<string, unknown>> {
  return {
    type: 'raster-dem',
    tiles: hillshade.tiles,
    encoding: 'terrarium',
    tileSize: hillshade.tileSize,
    maxzoom: hillshade.maxzoom,
    attribution: hillshade.attribution,
  };
}

/** The layers of a selection, bottom first: the political map's parts around the relief and the overlays. */
function selectionLayers(style: StyleJson, selection: StyleSelection, relief: boolean): StyleLayerJson[] {
  if (selection.landscape === true) return landscapeSelection(style, selection, relief);
  const political = selection.map === true ? politicalParts(style, selection.language) : undefined;
  if (selection.map === true && political === undefined) return [...(relief ? reliefLayers() : []), ...style.layers];
  if (political === undefined) {
    const background = {
      id: 'europe-relief-background',
      type: 'background',
      paint: { 'background-color': POLITICAL_COLORS.land },
    };
    return [
      ...(relief ? [background, ...reliefLayers()] : []),
      ...overlayLayers(style, selection),
      ...labelOverlays(style, selection, !relief),
    ];
  }
  // The political map's own names and borders replace the style's labels overlay.
  const overlays = overlayLayers(style, { ...selection, labels: false });
  return [
    ...political.background,
    ...(relief ? reliefLayers() : []),
    ...political.water,
    ...overlays.filter((l) => l.type !== 'fill-extrusion'),
    ...political.borders,
    ...overlays.filter((l) => l.type === 'fill-extrusion'),
    ...political.labels,
  ];
}

/**
 * The style of a selection: the political map, or the overlays over the imagery below (no background), with the
 * relief under the map's water, roads, borders and names when asked for; undefined when nothing is selected.
 */
export function composeStyle(
  style: StyleJson,
  selection: StyleSelection,
  hillshade?: HillshadeSource,
): StyleJson | undefined {
  const relief = selection.hillshade === true && hillshade !== undefined;
  const layers = selectionLayers(style, selection, relief);
  if (layers.length === 0) return undefined;
  const sources: Record<string, Readonly<Record<string, unknown>>> = {};
  if (relief) sources[HILLSHADE_SOURCE] = reliefSource(hillshade);
  for (const layer of layers)
    if (layer.source !== undefined && layer.source !== HILLSHADE_SOURCE) {
      const source = style.sources[layer.source];
      if (source !== undefined) sources[layer.source] = source;
    }
  return { ...style, sources, layers };
}

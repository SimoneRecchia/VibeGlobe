// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * The vector styles of the Europe preset's map types, derived from one OpenStreetMap style in the OpenMapTiles schema
 * (OpenFreeMap's): the full style for the Map, its labels and borders, roads and buildings as overlays, and a hillshade
 * of the terrain for Relief. One composed style per selection, so the tiles shared by its parts load once.
 */

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
  /** The whole map style (Map), drawn over everything below it. */
  readonly map?: boolean;
  /** Place, water and peak names, and borders. */
  readonly labels?: boolean;
  /** Roads, railways and their names. */
  readonly roads?: boolean;
  /** Buildings, extruded to their heights. */
  readonly buildings?: boolean;
  /** A hillshade of the terrain (Relief). */
  readonly hillshade?: boolean;
}

/** OpenMapTiles source layers of each overlay. */
const LABEL_LAYERS = new Set(['place', 'water_name', 'mountain_peak', 'boundary', 'aerodrome_label']);
const ROAD_LAYERS = new Set(['transportation', 'transportation_name']);

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
    if (wanted) out.push(layer);
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

/**
 * The style of a selection: the whole map, or its overlays over the imagery below (no background), with a hillshade
 * first when asked for; undefined when nothing is selected.
 */
export function composeStyle(
  style: StyleJson,
  selection: StyleSelection,
  hillshade?: HillshadeSource,
): StyleJson | undefined {
  const layers: StyleLayerJson[] = [];
  const sources: Record<string, Readonly<Record<string, unknown>>> = {};
  if (selection.hillshade === true && hillshade !== undefined) {
    sources[HILLSHADE_SOURCE] = {
      type: 'raster-dem',
      tiles: hillshade.tiles,
      encoding: 'terrarium',
      tileSize: hillshade.tileSize,
      maxzoom: hillshade.maxzoom,
      attribution: hillshade.attribution,
    };
    if (selection.map !== true)
      layers.push({ id: 'europe-relief-background', type: 'background', paint: { 'background-color': '#f2efe9' } });
    layers.push({
      id: 'europe-hillshade',
      type: 'hillshade',
      source: HILLSHADE_SOURCE,
      paint: { 'hillshade-exaggeration': 0.5, 'hillshade-shadow-color': '#473b24' },
    });
  }
  const own = selection.map === true ? [...style.layers] : overlayLayers(style, selection);
  // The hillshade sits above the map's background and land cover, below its lines and labels.
  if (selection.map === true && layers.length > 0) {
    const firstLine = own.findIndex((l) => l.type === 'line' || l.type === 'symbol');
    const at = firstLine < 0 ? own.length : firstLine;
    own.splice(at, 0, ...layers.filter((l) => l.type === 'hillshade'));
    layers.length = 0;
  }
  layers.push(...own);
  if (layers.length === 0) return undefined;
  for (const layer of layers)
    if (layer.source !== undefined && layer.source !== HILLSHADE_SOURCE) {
      const source = style.sources[layer.source];
      if (source !== undefined) sources[layer.source] = source;
    }
  return { ...style, sources, layers };
}

/**
 * The tile step of vector datasets (F341): an OpenStreetMap PBF extract read in three streaming passes (ways to find
 * the nodes they need, nodes, then ways again), cut into Mapbox Vector Tiles with roads, places and buildings.
 */
import { join } from 'node:path';
import type { DatasetConfig } from '../config/schema.js';
import { type Area, areaTiles } from '../tiles/area.js';
import { type VectorFeature, placeFeature, wantedWay, wayFeature } from '../vector/features.js';
import { encodeTile, type TileFeature } from '../vector/mvt.js';
import { fileSource, scanPbf } from '../vector/osm-pbf.js';
import { featureInTile, featureTileRange } from '../vector/tiler.js';
import type { DatasetFolders } from './raster-dataset.js';

const LAYERS = ['buildings', 'roads', 'places'] as const;

/** Sorted unique node ids with their coordinates, in typed arrays (no per-node objects). */
class NodeIndex {
  ids: Float64Array;
  lons: Float64Array;
  lats: Float64Array;

  constructor(ids: number[]) {
    const sorted = Float64Array.from(ids).sort();
    let unique = 0;
    for (let i = 0; i < sorted.length; i++)
      if (i === 0 || sorted[i] !== sorted[i - 1]) sorted[unique++] = sorted[i] ?? 0;
    this.ids = sorted.slice(0, unique);
    this.lons = new Float64Array(unique).fill(NaN);
    this.lats = new Float64Array(unique).fill(NaN);
  }

  find(id: number): number {
    let lo = 0;
    let hi = this.ids.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const value = this.ids[mid] ?? 0;
      if (value === id) return mid;
      if (value < id) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }
}

/** Reads the features of an extract. */
function readFeatures(path: string): VectorFeature[] {
  const source = fileSource(path);
  try {
    const refs: number[] = [];
    scanPbf(source, { way: (way) => wantedWay(way) && refs.push(...way.refs) });
    const index = new NodeIndex(refs);
    refs.length = 0;
    const features: VectorFeature[] = [];
    scanPbf(source, {
      node: (node) => {
        const at = index.find(node.id);
        if (at >= 0) {
          index.lons[at] = node.lon;
          index.lats[at] = node.lat;
        }
        const place = placeFeature(node);
        if (place) features.push(place);
      },
    });
    scanPbf(source, {
      way: (way) => {
        if (!wantedWay(way)) return;
        const coordinates: [number, number][] = [];
        for (const ref of way.refs) {
          const at = index.find(ref);
          if (at < 0 || Number.isNaN(index.lons[at])) return; // A way cut by the extract boundary is left out.
          coordinates.push([index.lons[at] ?? 0, index.lats[at] ?? 0]);
        }
        const feature = wayFeature(way, coordinates);
        if (feature) features.push(feature);
      },
    });
    return features;
  } finally {
    source.close();
  }
}

/** Cuts the features of one zoom level into the area's tiles; returns encoded tiles by key. */
function tileFeatures(features: VectorFeature[], area: Area, z: number): Map<string, Uint8Array> {
  const wanted = new Set([...areaTiles(area, z)].map((t) => `${t.x}/${t.y}`));
  const byTile = new Map<string, Map<string, TileFeature[]>>();
  for (const feature of features) {
    if (feature.minZoom > z) continue;
    const range = featureTileRange(feature, z);
    for (let y = range.minY; y <= range.maxY; y++) {
      for (let x = range.minX; x <= range.maxX; x++) {
        const key = `${x}/${y}`;
        if (!wanted.has(key)) continue;
        const clipped = featureInTile(feature, z, x, y);
        if (!clipped) continue;
        let layers = byTile.get(key);
        if (!layers) byTile.set(key, (layers = new Map()));
        const list = layers.get(feature.layer) ?? [];
        list.push(clipped);
        layers.set(feature.layer, list);
      }
    }
  }
  const tiles = new Map<string, Uint8Array>();
  for (const [key, layers] of [...byTile.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    tiles.set(key, encodeTile(LAYERS.map((name) => [name, layers.get(name) ?? []])));
  }
  return tiles;
}

/** The tile step of a vector dataset: writes `z/x/y.pbf` for every tile with features. */
export function tileVectorDataset(
  dataset: DatasetConfig,
  area: Area,
  files: string[],
  folders: DatasetFolders,
): { built: number; skipped: number } {
  const features = files.flatMap((file) => readFeatures(file));
  folders.report(`read ${features.length} features`);
  let built = 0;
  let skipped = 0;
  for (let z = dataset.maxZoom; z >= dataset.minZoom; z--) {
    for (const [key, bytes] of tileFeatures(features, area, z)) {
      const path = join(folders.tiles, `${z}/${key}.pbf`);
      if (folders.log.check('tile', `${z}/${key}`, path) === 'done') skipped++;
      else {
        folders.log.write('tile', `${z}/${key}`, path, bytes);
        built++;
      }
    }
    folders.report(`z${z}: vector tiles written`);
  }
  return { built, skipped };
}

// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * The tile step of vector datasets (F341): an OpenStreetMap PBF extract read in three streaming passes (ways to find
 * the nodes they need, nodes, then ways again), cut into Mapbox Vector Tiles with roads, places and buildings.
 */
import { appendFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { DatasetConfig } from '../config/schema.js';
import { type Area, areaTiles } from '../tiles/area.js';
import { type VectorFeature, placeFeature, wantedWay, wayFeature } from '../vector/features.js';
import { encodeTile, type TileFeature } from '../vector/mvt.js';
import { fileSource, scanPbf } from '../vector/osm-pbf.js';
import { featureInTile, featureTileRange } from '../vector/tiler.js';
import type { DatasetFolders } from './raster-dataset.js';

const LAYERS = ['buildings', 'roads', 'places'] as const;

/** A growing list of node ids in a typed array: a national extract references hundreds of millions (DP-004). */
class IdList {
  values = new Float64Array(1 << 16);
  length = 0;

  push(id: number): void {
    if (this.length === this.values.length) {
      const grown = new Float64Array(this.values.length * 2);
      grown.set(this.values);
      this.values = grown;
    }
    this.values[this.length++] = id;
  }
}

/** Sorted unique node ids with their coordinates in OSM's 1e-7° units, in typed arrays (no per-node objects). */
class NodeIndex {
  ids: Float64Array;
  lons: Int32Array;
  lats: Int32Array;

  constructor(list: IdList) {
    const sorted = list.values.subarray(0, list.length).sort();
    let unique = 0;
    for (let i = 0; i < sorted.length; i++)
      if (i === 0 || sorted[i] !== sorted[i - 1]) sorted[unique++] = sorted[i] ?? 0;
    this.ids = sorted.slice(0, unique);
    this.lons = new Int32Array(unique).fill(MISSING);
    this.lats = new Int32Array(unique);
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

/** A coordinate no node has (1e-7° units span ±1.8e9). */
const MISSING = -(2 ** 31);
/** Zoom of the chunks the features are spilled into, so a national extract never sits in memory whole (DP-004). */
const CHUNK_ZOOM = 10;
/** Buffered chunk lines flushed to disk past this many characters. */
const FLUSH_CHARS = 64 * 1024 * 1024;

/** Where the features read go: those of the zooms below the chunk zoom in memory, every one to its chunks on disk. */
class FeatureSink {
  readonly low: VectorFeature[] = [];
  readonly chunks = new Set<string>();
  readonly #pending = new Map<string, string[]>();
  #chars = 0;
  count = 0;

  constructor(
    private readonly folder: string,
    private readonly chunkZoom: number,
    private readonly maxZoom: number,
  ) {
    rmSync(folder, { recursive: true, force: true });
    mkdirSync(folder, { recursive: true });
  }

  add(feature: VectorFeature): void {
    this.count++;
    if (feature.minZoom < this.chunkZoom) this.low.push(feature);
    if (this.maxZoom < this.chunkZoom) return;
    const line = JSON.stringify(feature);
    const range = featureTileRange(feature, this.chunkZoom);
    for (let y = range.minY; y <= range.maxY; y++)
      for (let x = range.minX; x <= range.maxX; x++) {
        const key = `${x}_${y}`;
        this.chunks.add(key);
        const lines = this.#pending.get(key) ?? [];
        lines.push(line);
        this.#pending.set(key, lines);
        this.#chars += line.length;
      }
    if (this.#chars > FLUSH_CHARS) this.flush();
  }

  flush(): void {
    for (const [key, lines] of this.#pending) appendFileSync(this.path(key), `${lines.join('\n')}\n`);
    this.#pending.clear();
    this.#chars = 0;
  }

  path(key: string): string {
    return join(this.folder, `${key}.jsonl`);
  }
}

/** Reads the features of an extract that the dataset's zooms show into `sink`. */
function readFeatures(path: string, maxZoom: number, sink: FeatureSink): void {
  const source = fileSource(path);
  try {
    const refs = new IdList();
    scanPbf(source, {
      way: (way) => {
        if (wantedWay(way, maxZoom)) for (const ref of way.refs) refs.push(ref);
      },
    });
    const index = new NodeIndex(refs);
    refs.values = new Float64Array(0);
    scanPbf(source, {
      node: (node) => {
        const at = index.find(node.id);
        if (at >= 0) {
          index.lons[at] = Math.round(node.lon * 1e7);
          index.lats[at] = Math.round(node.lat * 1e7);
        }
        const place = placeFeature(node, maxZoom);
        if (place) sink.add(place);
      },
    });
    scanPbf(source, {
      way: (way) => {
        if (!wantedWay(way, maxZoom)) return;
        const coordinates: [number, number][] = [];
        for (const ref of way.refs) {
          const at = index.find(ref);
          if (at < 0 || index.lons[at] === MISSING) return; // A way cut by the extract boundary is left out.
          coordinates.push([(index.lons[at] ?? 0) / 1e7, (index.lats[at] ?? 0) / 1e7]);
        }
        const feature = wayFeature(way, coordinates);
        if (feature) sink.add(feature);
      },
    });
  } finally {
    source.close();
  }
}

/** Cuts the features of one zoom level into the area's tiles; returns encoded tiles by key. */
function tileFeatures(
  features: VectorFeature[],
  area: Area,
  z: number,
  chunk?: { x: number; y: number; z: number },
): Map<string, Uint8Array> {
  const shift = chunk ? z - chunk.z : 0;
  const inChunk = (t: { x: number; y: number }): boolean =>
    !chunk || (Math.floor(t.x / 2 ** shift) === chunk.x && Math.floor(t.y / 2 ** shift) === chunk.y);
  const wanted = new Set([...areaTiles(area, z)].filter(inChunk).map((t) => `${t.x}/${t.y}`));
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
  chunkZoom = CHUNK_ZOOM,
): { built: number; skipped: number } {
  const sink = new FeatureSink(join(folders.work, 'chunks'), chunkZoom, dataset.maxZoom);
  for (const file of files) readFeatures(file, dataset.maxZoom, sink);
  sink.flush();
  folders.report(`read ${sink.count} features, ${sink.chunks.size} chunks of zoom ${chunkZoom} on disk`);
  const counts = { built: 0, skipped: 0 };
  const write = (z: number, tiles: Map<string, Uint8Array>): void => {
    for (const [key, bytes] of tiles) {
      const path = join(folders.tiles, `${z}/${key}.pbf`);
      if (folders.log.check('tile', `${z}/${key}`, path) === 'done') counts.skipped++;
      else {
        folders.log.write('tile', `${z}/${key}`, path, bytes);
        counts.built++;
      }
    }
  };
  for (const key of [...sink.chunks].sort()) {
    const [x = 0, y = 0] = key.split('_').map(Number);
    const lines = readFileSync(sink.path(key), 'utf8').split('\n');
    const features = lines.filter((line) => line !== '').map((line) => JSON.parse(line) as VectorFeature);
    for (let z = dataset.maxZoom; z >= Math.max(dataset.minZoom, chunkZoom); z--)
      write(z, tileFeatures(features, area, z, { x, y, z: chunkZoom }));
  }
  for (let z = Math.min(dataset.maxZoom, chunkZoom - 1); z >= dataset.minZoom; z--) {
    write(z, tileFeatures(sink.low, area, z));
    folders.report(`z${z}: vector tiles written`);
  }
  folders.report(`z${chunkZoom}–${dataset.maxZoom}: vector tiles written by chunk`);
  return counts;
}

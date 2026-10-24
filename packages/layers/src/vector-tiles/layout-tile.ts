/**
 * Lays out one vector tile for the style layers that read its source (F443): decodes the MVT, filters features,
 * clips and tessellates fills, lines and extrusions, and prepares labels (text, glyph ranges, anchors). It runs as a
 * worker-pool task (`VECTOR_TILE_TASKS`), so the main thread only uploads the result. Buckets keep one
 * `featureIndex` per vertex and the kept features, so data-driven paint is re-evaluated at runtime without
 * tessellating again (F450).
 */
import type { TaskOutput, TaskTable } from '@vibeglobe/core';
import { decodeMvt, type MvtFeature, type MvtLayer } from '@vibeglobe/sources/vector';
import { buildingHeight, extrudeBuilding, resolveBuildingParts, type BuildingFeature } from './buildings.js';
import { tessellateFill, tileClipRect, type ClipRect, type TilePoint } from './fill-tessellate.js';
import { glyphRanges } from './glyphs.js';
import { densifyLine, globeVertices, maxEdgeUnits, subdividedFill, type GlobeVertices } from './globe-vertices.js';
import { clipLine, tessellateLine, type LineCap, type LineJoin } from './line-tessellate.js';
import { StyleLayer, type StyleLayerJson } from './style-layer.js';
import { toTargetTile, type OverzoomTransform, type TileId } from './tile-pyramid.js';

/** Extent every bucket is expressed in, whatever the source layer's extent. */
export const BUCKET_EXTENT = 4096;
/** The layer of a GeoJSON source's tiles, which its style layers read (they have no `source-layer`; F444). */
export const GEOJSON_LAYER = '_geojsonTileLayer';

/** Clip buffer around the tile, in bucket units (MapLibre's default buffer is 128 of 4096 too). */
export const BUCKET_BUFFER = 128;

/** A feature kept by a bucket. */
export interface BucketFeature {
  readonly id: number | undefined;
  readonly type: MvtFeature['type'];
  readonly properties: MvtFeature['properties'];
}

/** Geometry with per-vertex feature indices. */
export interface BucketGeometry {
  /** Fill: x, y. Line: x, y. Extrusion: x, y, z (meters). Circle and symbol anchors: x, y. */
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
  readonly featureIndex: Uint32Array;
  /** Line extrusion vectors (ex, ey) and distances; extrusion normals (nx, ny, nz). */
  readonly extrusions?: Float32Array;
  readonly distances?: Float32Array;
  readonly normals?: Float32Array;
  /** Lines with a `line-gradient`: `line-progress` (0–1) of each vertex along its whole line (F445). */
  readonly progress?: Float32Array;
  /** With `LayoutInput.tile`: each vertex placed on the globe and the flat map, relative to the tile's origin. */
  readonly globe?: GlobeVertices;
  /** Lines with `LayoutInput.tile`: the point a short step along each vertex's extrusion, for its screen direction. */
  readonly side?: GlobeVertices;
}

/** A label to place, before shaping (glyphs arrive separately). */
export interface BucketLabel {
  readonly feature: number;
  readonly text: string;
  /** The sprite icon drawn at a point anchor (`icon-image`), if any. */
  readonly icon?: string;
  /** Point anchor, or the line the label follows (`symbol-placement: line`), in bucket units. */
  readonly anchor?: TilePoint;
  readonly line?: readonly TilePoint[];
}

/** The laid-out content of one style layer in one tile. */
export interface Bucket {
  readonly layerId: string;
  readonly type: string;
  readonly features: readonly BucketFeature[];
  readonly geometry?: BucketGeometry;
  readonly labels?: readonly BucketLabel[];
  /** Glyph range starts the labels need, per font stack. */
  readonly glyphRanges?: Readonly<Record<string, readonly number[]>>;
}

/** The input of `layout-vector-tile`. */
export interface LayoutInput {
  readonly bytes: ArrayBuffer;
  /** The style layers of this tile's source (`StyleLayer.json`). */
  readonly layers: readonly StyleLayerJson[];
  /** The zoom the tile is laid out for (the target tile's zoom when overzoomed). */
  readonly zoom: number;
  /** Present when the tile is read from a lower-zoom source tile. */
  readonly overzoom?: OverzoomTransform;
  /**
   * The target tile: when given, long edges are split to follow the globe and every vertex gets its globe attributes
   * (`BucketGeometry.globe`, ADR 0131), so the main thread only uploads.
   */
  readonly tile?: TileId;
}

/** The longest straight piece of a line drawn on the globe, in tile units, so draped lines follow the relief. */
export const DRAPE_EDGE_UNITS = 256;

/** The step along a line vertex's extrusion whose screen projection gives the extrusion's screen direction. */
export const SIDE_STEP_UNITS = 4;

type Geometry = readonly (readonly TilePoint[])[];

function scaled(feature: MvtFeature, extent: number, transform: OverzoomTransform | undefined): Geometry {
  const k = BUCKET_EXTENT / extent;
  return feature.geometry.map((part) =>
    part.map(([x, y]): TilePoint => {
      const p: TilePoint = [x * k, y * k];
      return transform === undefined ? p : toTargetTile(transform, BUCKET_EXTENT, p[0], p[1]);
    }),
  );
}

class GeometryWriter {
  readonly positions: number[] = [];
  readonly indices: number[] = [];
  readonly featureIndex: number[] = [];
  readonly extrusions: number[] = [];
  readonly distances: number[] = [];
  readonly normals: number[] = [];
  readonly progress: number[] = [];

  append(
    feature: number,
    stride: number,
    g: {
      positions: Float32Array;
      indices: Uint32Array;
      extrusions?: Float32Array;
      distances?: Float32Array;
      normals?: Float32Array;
      progress?: Float32Array;
    },
  ): void {
    const base = this.featureIndex.length;
    const count = g.positions.length / stride;
    this.positions.push(...g.positions);
    for (let i = 0; i < count; i++) this.featureIndex.push(feature);
    for (const index of g.indices) this.indices.push(base + index);
    if (g.extrusions !== undefined) this.extrusions.push(...g.extrusions);
    if (g.distances !== undefined) this.distances.push(...g.distances);
    if (g.normals !== undefined) this.normals.push(...g.normals);
    if (g.progress !== undefined) this.progress.push(...g.progress);
  }

  build(): BucketGeometry {
    const optional = (values: number[]) => (values.length > 0 ? new Float32Array(values) : undefined);
    const extrusions = optional(this.extrusions);
    const distances = optional(this.distances);
    const normals = optional(this.normals);
    const progress = optional(this.progress);
    return {
      positions: new Float32Array(this.positions),
      indices: new Uint32Array(this.indices),
      featureIndex: new Uint32Array(this.featureIndex),
      ...(extrusions === undefined ? {} : { extrusions }),
      ...(distances === undefined ? {} : { distances }),
      ...(normals === undefined ? {} : { normals }),
      ...(progress === undefined ? {} : { progress }),
    };
  }
}

function sortKeyName(type: string): string | undefined {
  return { fill: 'fill-sort-key', line: 'line-sort-key', circle: 'circle-sort-key', symbol: 'symbol-sort-key' }[type];
}

function selectFeatures(layer: StyleLayer, source: MvtLayer, zoom: number): MvtFeature[] {
  const kept = source.features.filter((f) => f.type !== 'Unknown' && layer.filter(zoom, f));
  const key = sortKeyName(layer.type);
  if (key === undefined || layer.json.layout?.[key] === undefined) return kept;
  const value = (f: MvtFeature) => Number(layer.layout(key, zoom, f)) || 0;
  return kept
    .map((f) => [value(f), f] as const)
    .sort((a, b) => a[0] - b[0])
    .map(([, f]) => f);
}

function layoutFill(
  features: readonly MvtFeature[],
  geometry: (f: MvtFeature) => Geometry,
  clip: ClipRect,
  cellUnits: number,
): BucketGeometry {
  const writer = new GeometryWriter();
  features.forEach((feature, index) => {
    if (feature.type !== 'Polygon') return;
    const rings = geometry(feature);
    writer.append(
      index,
      2,
      Number.isFinite(cellUnits) ? subdividedFill(rings, clip, cellUnits) : tessellateFill(rings, clip),
    );
  });
  return writer.build();
}

/** Edge length of lines with a gradient, in bucket units: their colors are per vertex (F445). */
const GRADIENT_EDGE_UNITS = 64;

/**
 * `line-progress` of a tessellated piece's vertices: its distance along the piece, mapped onto the share of the whole
 * line the piece covers (`mapbox_clip_start` and `mapbox_clip_end` of GeoJSON tiles with line metrics; else all).
 */
function lineProgress(feature: MvtFeature, piece: readonly TilePoint[], distances: Float32Array): Float32Array {
  let length = 0;
  for (let i = 1; i < piece.length; i++)
    length += Math.hypot(
      (piece[i]?.[0] ?? 0) - (piece[i - 1]?.[0] ?? 0),
      (piece[i]?.[1] ?? 0) - (piece[i - 1]?.[1] ?? 0),
    );
  const start = Number(feature.properties['mapbox_clip_start'] ?? 0);
  const end = Number(feature.properties['mapbox_clip_end'] ?? 1);
  return distances.map((d) => start + (d / (length || 1)) * (end - start));
}

function layoutLine(
  layer: StyleLayer,
  zoom: number,
  features: readonly MvtFeature[],
  geometry: (f: MvtFeature) => Geometry,
  clip: ClipRect,
  maxEdge: number,
  outline = false,
): BucketGeometry {
  const writer = new GeometryWriter();
  const gradient = !outline && layer.json.paint?.['line-gradient'] !== undefined;
  const edge = gradient ? Math.min(maxEdge, GRADIENT_EDGE_UNITS) : maxEdge;
  features.forEach((feature, index) => {
    if (feature.type === 'Point' || (outline && feature.type !== 'Polygon')) return;
    const options = outline
      ? { join: 'miter' as LineJoin, cap: 'butt' as LineCap, miterLimit: 2 }
      : {
          join: layer.layout('line-join', zoom, feature) as LineJoin,
          cap: layer.layout('line-cap', zoom, feature) as LineCap,
          miterLimit: Number(layer.layout('line-miter-limit', zoom, feature)),
        };
    for (const part of geometry(feature)) {
      // A fill's outline follows each ring around, closed.
      const path = outline && part[0] !== undefined ? [...part, part[0]] : part;
      for (const clipped of clipLine(densifyLine(path, edge), clip)) {
        const g = tessellateLine(clipped, options, clip);
        writer.append(
          index,
          2,
          gradient && g.distances ? { ...g, progress: lineProgress(feature, clipped, g.distances) } : g,
        );
      }
    }
  });
  return writer.build();
}

function layoutExtrusion(
  features: readonly MvtFeature[],
  geometry: (f: MvtFeature) => Geometry,
  clip: ClipRect,
): BucketGeometry {
  const writer = new GeometryWriter();
  const buildings: (BuildingFeature & { index: number })[] = features
    .map((f, index) => ({ id: f.id, rings: geometry(f), properties: f.properties, index }))
    .filter((_, i) => features[i]?.type === 'Polygon');
  for (const building of resolveBuildingParts(buildings) as (BuildingFeature & { index: number })[]) {
    writer.append(building.index, 3, extrudeBuilding(building.rings, buildingHeight(building.properties), clip));
  }
  return writer.build();
}

function layoutPoints(
  features: readonly MvtFeature[],
  geometry: (f: MvtFeature) => Geometry,
  clip: ClipRect,
): BucketGeometry {
  const writer = new GeometryWriter();
  features.forEach((feature, index) => {
    if (feature.type !== 'Point') return;
    for (const [p] of geometry(feature)) {
      if (
        p !== undefined &&
        p[0] >= 0 &&
        p[1] >= 0 &&
        p[0] < clip.maxX - BUCKET_BUFFER &&
        p[1] < clip.maxY - BUCKET_BUFFER
      ) {
        writer.append(index, 2, { positions: new Float32Array(p), indices: new Uint32Array(0) });
      }
    }
  });
  return writer.build();
}

function layoutSymbols(
  layer: StyleLayer,
  zoom: number,
  features: readonly MvtFeature[],
  geometry: (f: MvtFeature) => Geometry,
  clip: ClipRect,
): Pick<Bucket, 'labels' | 'glyphRanges'> {
  const labels: BucketLabel[] = [];
  const ranges: Record<string, Set<number>> = {};
  const alongLines = layer.layout('symbol-placement', zoom) !== 'point';
  const tokens = !Array.isArray(layer.json.layout?.['text-field']);
  features.forEach((feature, index) => {
    const transform = layer.layout('text-transform', zoom, feature);
    const raw = String(layer.layout('text-field', zoom, feature) ?? '');
    // Legacy token strings (`"{name}"`, also inside zoom functions) read feature properties; expressions do not.
    const field = tokens
      ? raw.replace(/\{([^{}]+)\}/g, (_, key: string) => String(feature.properties[key] ?? ''))
      : raw;
    const text =
      transform === 'uppercase' ? field.toUpperCase() : transform === 'lowercase' ? field.toLowerCase() : field;
    const icon = String(layer.layout('icon-image', zoom, feature) ?? '');
    if (text === '' && icon === '') return;
    const font = (layer.layout('text-font', zoom, feature) as string[] | undefined)?.join(',') ?? '';
    const set = (ranges[font] ??= new Set());
    for (const start of glyphRanges(text)) set.add(start);
    for (const part of geometry(feature)) {
      if (alongLines && feature.type !== 'Point') {
        for (const line of clipLine(part, clip)) labels.push({ feature: index, text, line });
      } else if (part[0] !== undefined) {
        const [x, y] = part[0];
        if (x >= 0 && y >= 0 && x < BUCKET_EXTENT && y < BUCKET_EXTENT)
          labels.push({ feature: index, text, anchor: part[0], ...(icon === '' ? {} : { icon }) });
      }
    }
  });
  const glyphRangesOut = Object.fromEntries(Object.entries(ranges).map(([k, v]) => [k, [...v].sort((a, b) => a - b)]));
  return { labels, glyphRanges: glyphRangesOut };
}

function layoutLayer(
  layer: StyleLayer,
  source: MvtLayer,
  input: LayoutInput,
  clip: ClipRect,
  type: string = layer.type,
): Bucket {
  const features = selectFeatures(layer, source, input.zoom);
  const geometry = (f: MvtFeature) => scaled(f, source.extent, input.overzoom);
  const kept = features.map((f) => ({ id: f.id, type: f.type, properties: f.properties }));
  const base = { layerId: layer.id, type, features: kept };
  const maxEdge = input.tile === undefined ? Infinity : maxEdgeUnits(input.tile.z, BUCKET_EXTENT);
  // Draped on terrain, lines and fills also need vertices often enough to follow the relief (F452).
  const draped = input.tile === undefined ? Infinity : DRAPE_EDGE_UNITS;
  switch (type) {
    case 'fill':
      return { ...base, geometry: layoutFill(features, geometry, clip, Math.min(maxEdge, 2 * draped)) };
    case 'fill-outline':
      return {
        ...base,
        geometry: layoutLine(layer, input.zoom, features, geometry, clip, Math.min(maxEdge, draped), true),
      };
    case 'line':
      return { ...base, geometry: layoutLine(layer, input.zoom, features, geometry, clip, Math.min(maxEdge, draped)) };
    case 'fill-extrusion':
      return { ...base, geometry: layoutExtrusion(features, geometry, clip) };
    case 'circle':
    case 'heatmap':
      return { ...base, geometry: layoutPoints(features, geometry, clip) };
    case 'symbol':
      return { ...base, ...layoutSymbols(layer, input.zoom, features, geometry, clip) };
    default:
      return base;
  }
}

/** Lays out a tile; a tile that does not decode yields no buckets. Problems in a layer's style skip that layer. */
export function layoutVectorTile(input: LayoutInput): Bucket[] {
  const tile = decodeMvt(input.bytes);
  if (tile === undefined) return [];
  const clip = tileClipRect(BUCKET_EXTENT, BUCKET_BUFFER);
  const buckets: Bucket[] = [];
  for (const json of input.layers) {
    const layer = new StyleLayer(json);
    // Hidden layers are laid out too, so showing them again needs no new layout (F447, F450).
    const source = tile.layers.find((l) => l.name === (layer.sourceLayer ?? GEOJSON_LAYER));
    if (source === undefined) continue;
    // A fill with an outline color also gets its outline (F445).
    const types =
      layer.type === 'fill' && layer.json.paint?.['fill-outline-color'] !== undefined
        ? ['fill', 'fill-outline']
        : [layer.type];
    for (const type of types) {
      const bucket = layoutLayer(layer, source, input, clip, type);
      buckets.push(input.tile === undefined ? bucket : placed(bucket, input.tile));
    }
  }
  return buckets;
}

/** Adds the globe attributes of a bucket's vertices (and of the lines' side points). */
function placed(bucket: Bucket, tile: TileId): Bucket {
  const g = bucket.geometry;
  if (g === undefined || g.featureIndex.length === 0) return bucket;
  const stride = bucket.type === 'fill-extrusion' ? 3 : 2;
  const globe = globeVertices(tile, BUCKET_EXTENT, g.positions, stride);
  if (g.extrusions === undefined) return { ...bucket, geometry: { ...g, globe } };
  const sides = new Float32Array(g.positions.length);
  for (let i = 0; i < sides.length; i += 2) {
    const ex = g.extrusions[i] ?? 0;
    const ey = g.extrusions[i + 1] ?? 0;
    const k = SIDE_STEP_UNITS / (Math.hypot(ex, ey) || 1);
    sides[i] = (g.positions[i] ?? 0) + ex * k;
    sides[i + 1] = (g.positions[i + 1] ?? 0) + ey * k;
  }
  return { ...bucket, geometry: { ...g, globe, side: globeVertices(tile, BUCKET_EXTENT, sides, 2) } };
}

function transfers(buckets: readonly Bucket[]): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  for (const { geometry } of buckets) {
    if (geometry === undefined) continue;
    for (const array of [
      geometry.positions,
      geometry.indices,
      geometry.featureIndex,
      geometry.extrusions,
      geometry.distances,
      geometry.normals,
      geometry.progress,
      ...[geometry.globe, geometry.side].flatMap((v) => (v === undefined ? [] : [v.positions, v.normals, v.planes])),
    ]) {
      if (array !== undefined) out.push(array.buffer as ArrayBuffer);
    }
  }
  return out;
}

/**
 * The worker task of vector tiles (ADR 0011): `layout-vector-tile` (`LayoutInput` → `Bucket[]`, typed arrays
 * transferred). It marks `vibeglobe:layout-vector-tile` in the worker's performance timeline (F443). The engine's
 * worker program registers this table (hook request in `docs/parallel-tracks.md`).
 */
export const VECTOR_TILE_TASKS: TaskTable = Object.freeze({
  'layout-vector-tile': (input: unknown): TaskOutput => {
    const value = input as Partial<LayoutInput> | null;
    if (!(value?.bytes instanceof ArrayBuffer) || !Array.isArray(value.layers) || typeof value.zoom !== 'number') {
      throw Object.assign(new Error('layout-vector-tile needs bytes, layers and zoom'), { code: 'invalid-input' });
    }
    const start = performance.now();
    const buckets = layoutVectorTile(value as LayoutInput);
    performance.measure('vibeglobe:layout-vector-tile', { start, end: performance.now() });
    return { output: buckets, transfer: transfers(buckets) };
  },
});

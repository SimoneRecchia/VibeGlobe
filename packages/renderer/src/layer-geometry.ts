// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import {
  layerOrigin,
  writeLayerVertex,
  type BatchAttribute,
  type FeatureGeometry,
  type LayerGround,
  type LayerOrigin,
} from '@vibeglobe/core';
import earcut from 'earcut';
import { valueOf, type BatchContents } from './layer-contents.js';

export { valueOf, type BatchContents } from './layer-contents.js';
import {
  DRAPE_STEP_DEG,
  extentOf,
  forEachPart,
  greatCirclePoints,
  MAX_DRAPE_PIECES,
  MAX_STEP_DEG,
  subdivide,
  vertexOf,
  type Triangle,
} from './layer-subdivision.js';
import { nearestLon, originLonDeg, unwrappedPolygon, worldCopies, wrappedLon } from './layer-antimeridian.js';
import { LABEL_BUFFER_TEXELS, labelReferencePx, SDF_UNITS_PER_TEXEL } from './label-sdf.js';
import { writePointQuad } from './layer-points.hot.js';

/** The vertex arrays of a layer mesh, sized for its vertices (ADR 0037). */
export interface LayerArrays {
  readonly origin: LayerOrigin;
  readonly vertices: number;
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly planes: Float32Array;
  readonly heights: Float32Array;
  readonly colors: Float32Array;
  readonly corners: Float32Array;
  /**
   * Four per vertex: atlas coordinates of labels and marker images, (−1, −1) where a quad is a solid shape; for labels
   * the halo's sRGB color packed as 0xRRGGBB and its alpha (F358).
   */
  readonly uvs: Float32Array;
  readonly indices: Uint32Array;
  /** Lines only: the other endpoint of each vertex's segment. */
  readonly other?: { positions: Float32Array; normals: Float32Array; planes: Float32Array; heights: Float32Array };
}

/** The vertex values of a hidden quad: transparent, collapsed, without an image. */
const HIDDEN_COLOR = [0, 0, 0, 0];
const HIDDEN_CORNER = [0, 0, 2, 2];
const HIDDEN_UV = [-1, -1, 0, 0];

/** A feature's straight RGBA with its opacity and visibility applied to alpha. */
function colorOf(batch: BatchContents, feature: number, attribute: BatchAttribute = 'color'): number[] {
  const alpha = valueOf(batch, 'opacity', feature) * valueOf(batch, 'visible', feature);
  return [0, 1, 2, 3].map((c) => {
    const value = valueOf(batch, attribute, feature, c);
    // Style colors are sRGB (CSS); the renderer blends in linear light and encodes the output to sRGB.
    if (c === 3) return value * alpha;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
}

/** Growable arrays that a builder appends vertices to. */
class Builder {
  positions: number[] = [];
  normals: number[] = [];
  planes: number[] = [];
  heights: number[] = [];
  colors: number[] = [];
  corners: number[] = [];
  uvs: number[] = [];
  indices: number[] = [];
  other = { positions: [] as number[], normals: [] as number[], planes: [] as number[], heights: [] as number[] };
  private readonly one = { positions: new Float32Array(3), normals: new Float32Array(3), planes: new Float32Array(4) };

  /** Longitudes on the flat map (F368): nearest the origin (quads), the previous one (lines), or as given (rings). */
  private mode: 'origin' | 'chain' | 'raw' = 'origin';
  private previousLon = Number.NaN;
  readonly originLon: number;

  constructor(
    readonly origin: LayerOrigin,
    /** With a ground, heights are above the terrain under each vertex (clamped and draped features). */
    private readonly ground?: LayerGround,
  ) {
    this.originLon = originLonDeg(origin);
  }

  /** Starts a feature whose longitudes are placed as `mode` says. */
  startFeature(mode: 'origin' | 'chain' | 'raw'): void {
    this.mode = mode;
    this.previousLon = Number.NaN;
  }

  /** A longitude placed on the flat map's branch for the current feature. */
  private place(lonDeg: number): number {
    if (this.mode === 'raw') return lonDeg;
    const reference = this.mode === 'chain' && !Number.isNaN(this.previousLon) ? this.previousLon : this.originLon;
    const placed = nearestLon(lonDeg, reference);
    this.previousLon = placed;
    return placed;
  }

  /** The longest straight piece of a line or polygon edge, degrees: finer on the terrain, so drapes follow it. */
  stepDeg(extentDeg: number): number {
    return this.ground ? Math.min(MAX_STEP_DEG, Math.max(DRAPE_STEP_DEG, extentDeg / MAX_DRAPE_PIECES)) : MAX_STEP_DEG;
  }

  get count(): number {
    return this.heights.length;
  }

  /** Appends one vertex; with `to`, also the other endpoint of a line segment. */
  add(
    lonDeg: number,
    latDeg: number,
    heightMeters: number,
    color: number[],
    corner: number[],
    to?: number[],
    uv: number[] = HIDDEN_UV,
  ): void {
    const lon = this.place(lonDeg);
    this.attributesOf(lon, latDeg, this);
    this.heights.push(heightMeters + (this.ground?.heightAt(wrappedLon(lon), latDeg) ?? 0));
    this.colors.push(...color);
    this.corners.push(...corner);
    this.uvs.push(...uv);
    if (to) {
      // A segment's other end: on the branch next to this one.
      const toLon = nearestLon(to[0] ?? 0, lon);
      this.attributesOf(toLon, to[1] ?? 0, this.other);
      this.other.heights.push((to[2] ?? 0) + (this.ground?.heightAt(wrappedLon(toLon), to[1] ?? 0) ?? 0));
    }
  }

  private attributesOf(
    lonDeg: number,
    latDeg: number,
    into: { positions: number[]; normals: number[]; planes: number[] },
  ): void {
    writeLayerVertex(this.one, 0, lonDeg, latDeg, this.origin);
    into.positions.push(...this.one.positions);
    into.normals.push(...this.one.normals);
    into.planes.push(...this.one.planes);
  }

  arrays(line: boolean): LayerArrays {
    return {
      origin: this.origin,
      vertices: this.count,
      positions: Float32Array.from(this.positions),
      normals: Float32Array.from(this.normals),
      planes: Float32Array.from(this.planes),
      heights: Float32Array.from(this.heights),
      colors: Float32Array.from(this.colors),
      corners: Float32Array.from(this.corners),
      uvs: Float32Array.from(this.uvs),
      indices: Uint32Array.from(this.indices),
      ...(line
        ? {
            other: {
              positions: Float32Array.from(this.other.positions),
              normals: Float32Array.from(this.other.normals),
              planes: Float32Array.from(this.other.planes),
              heights: Float32Array.from(this.other.heights),
            },
          }
        : {}),
    };
  }
}

/** Two triangles over the last four vertices added: 0-1-2, 0-2-3. */
function quadIndices(builder: Builder): void {
  const base = builder.count - 4;
  builder.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

/** Where labels and marker images come from: label distance fields (`LabelSdf`) and images (`LayerAtlas`). */
export interface QuadImages {
  /** The distance field of a feature's text at a size in a font, or undefined while it is generated (F358). */
  text(text: string, sizePx: number, font: string, feature: number): AtlasRect | undefined;
  image(name: string): AtlasRect | undefined;
}

/** A region of the atlas, and its size in CSS pixels. */
interface AtlasRect {
  readonly u0: number;
  readonly v0: number;
  readonly u1: number;
  readonly v1: number;
  readonly widthPx: number;
  readonly heightPx: number;
}

/** Shift of a box of half-size (w, h) from its anchor, by `ANCHORS` index, in pixels (y up). */
function anchorShift(anchor: number, w: number, h: number): [number, number] {
  const x = [0, w, -w, 0, 0, w, -w, w, -w][anchor] ?? 0;
  const y = [0, 0, 0, -h, h, -h, -h, h, h][anchor] ?? 0;
  return [x, y];
}

/**
 * How a label's distance field is drawn (F357, F358): `layerCorner.zw` = (3 + the halo's width in field units, field
 * units per CSS pixel), `layerUv.zw` = `text-halo-color` as sRGB bytes, red × 256 + green and blue × 256 + alpha (the
 * alpha with the feature's opacity): 16 bits a value, which interpolation across the quad keeps to well under one.
 */
function labelShading(batch: BatchContents, feature: number): { corner: [number, number]; halo: [number, number] } {
  const sizePx = Math.max(valueOf(batch, 'sizePx', feature), 1e-3);
  const perPx = (SDF_UNITS_PER_TEXEL * labelReferencePx(sizePx)) / sizePx;
  // One texel inside the field's reach, where its value is still above 0 (a halo out to 0 would fill the quad).
  const haloTexels = Math.min(
    LABEL_BUFFER_TEXELS - 1,
    (valueOf(batch, 'widthPx', feature) * perPx) / SDF_UNITS_PER_TEXEL,
  );
  const opacity = valueOf(batch, 'opacity', feature);
  const byte = (c: number): number =>
    Math.round(Math.min(1, Math.max(0, valueOf(batch, 'outlineColor', feature, c) * (c === 3 ? opacity : 1))) * 255);
  return {
    corner: [3 + haloTexels * SDF_UNITS_PER_TEXEL, perPx],
    halo: [byte(0) * 256 + byte(1), byte(2) * 256 + byte(3)],
  };
}

/** The box of a quad feature: half-sizes and its atlas region (none: a solid shape). */
function boxOf(
  batch: BatchContents,
  feature: number,
  images: QuadImages | undefined,
): { w: number; h: number; rect: AtlasRect | undefined } {
  const size = valueOf(batch, 'sizePx', feature);
  // Points: `sizePx` is the radius (MapLibre `circle-radius`).
  if (batch.kind === 'point') return { w: size, h: size, rect: undefined };
  if (batch.kind === 'label') {
    // A label hidden by collision takes no atlas space (10,000 labels would overflow it); it is drawn into the atlas
    // when its fade-in starts, which rewrites its quad (F359).
    if (valueOf(batch, 'opacity', feature) * valueOf(batch, 'visible', feature) <= 0)
      return { w: 0, h: 0, rect: undefined };
    // Until its field arrives a label is collapsed: drawn once the field is in the atlas.
    const font = batch.strings.get('font')?.[feature] ?? '';
    const rect = images?.text(batch.strings.get('text')?.[feature] ?? '', size, font, feature);
    return rect ? { w: rect.widthPx / 2, h: rect.heightPx / 2, rect } : { w: 0, h: 0, rect };
  }
  // Markers: the image at `sizePx` tall (its natural height when unset), or a solid square without one.
  const name = batch.strings.get('icon')?.[feature] ?? '';
  const rect = images?.image(name);
  if (!rect) return { w: size / 2, h: size / 2, rect };
  const h = (batch.attributes.has('sizePx') || batch.uniforms.has('sizePx') ? size : rect.heightPx) / 2;
  return { w: (h * rect.widthPx) / rect.heightPx, h, rect };
}

/** The four vertices of a quad feature: anchor, color, and per corner its pixel offset and atlas coordinates. */
interface QuadVertices {
  readonly lon: number;
  readonly lat: number;
  readonly height: number;
  readonly color: number[];
  readonly corners: number[][];
  readonly uvs: number[][];
}

/** A quad feature's vertices; a hidden one collapses to its anchor, transparent, keeping its place in the buffers. */
function quadVertices(batch: BatchContents, feature: number, images: QuadImages | undefined): QuadVertices {
  const lon = valueOf(batch, 'position', feature, 0);
  const lat = valueOf(batch, 'position', feature, 1);
  const height = valueOf(batch, 'position', feature, 2);
  if (valueOf(batch, 'visible', feature) <= 0) {
    const none = [0, 0, 2, 2];
    return {
      lon,
      lat,
      height,
      color: [0, 0, 0, 0],
      corners: [none, none, none, none],
      uvs: [HIDDEN_UV, HIDDEN_UV, HIDDEN_UV, HIDDEN_UV],
    };
  }
  const { w, h, rect } = boxOf(batch, feature, images);
  const [ax, ay] = anchorShift(valueOf(batch, 'anchor', feature), w, h);
  // A label's offset is in ems of its text size (MapLibre's `text-offset`); a marker's in pixels.
  const unit = batch.kind === 'label' ? valueOf(batch, 'sizePx', feature) : 1;
  const dx = valueOf(batch, 'offsetPx', feature, 0) * unit + ax;
  const dy = -valueOf(batch, 'offsetPx', feature, 1) * unit + ay;
  const angle = (-valueOf(batch, 'rotationDeg', feature) * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const round = batch.kind === 'point';
  // Marker images keep their own colors (MapLibre tints only SDF icons): white, with the feature's alpha. A label's
  // color is its text's; its halo and field scale ride in the corner and uv spares (F358).
  const own = batch.kind === 'marker' && rect;
  const color = own ? [1, 1, 1, colorOf(batch, feature)[3] ?? 1] : colorOf(batch, feature);
  const label = batch.kind === 'label' && rect ? labelShading(batch, feature) : undefined;
  const corners: number[][] = [];
  const uvs: number[][] = [];
  for (const [sx, sy] of QUAD_CORNERS) {
    const x = sx * w;
    const y = sy * h;
    // corner.zw: the unit square for round points, 2 for every other quad.
    const zw = label ? label.corner : round ? [sx, sy] : [2, 2];
    corners.push([dx + x * cos - y * sin, dy + x * sin + y * cos, zw[0] ?? 2, zw[1] ?? 2]);
    // Atlas rows run downward: the quad's top (sy = 1) samples v0.
    uvs.push(
      rect
        ? [sx < 0 ? rect.u0 : rect.u1, sy > 0 ? rect.v0 : rect.v1, label?.halo[0] ?? 0, label?.halo[1] ?? 0]
        : HIDDEN_UV,
    );
  }
  return { lon, lat, height, color, corners, uvs };
}

const QUAD_CORNERS = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
] as const;

/**
 * Points, markers and labels: a screen-sized quad around each feature's position, four vertices per feature in feature
 * order (hidden ones collapsed), so a change to one feature rewrites only its vertices ({@link rewriteQuads}).
 */
function buildQuads(batch: BatchContents, builder: Builder, images: QuadImages | undefined): void {
  builder.startFeature('origin');
  for (let feature = 0; feature < batch.count; feature++) {
    const q = quadVertices(batch, feature, images);
    for (let c = 0; c < 4; c++) builder.add(q.lon, q.lat, q.height, q.color, q.corners[c] ?? [], undefined, q.uvs[c]);
    quadIndices(builder);
  }
  // Room for the features the layer reserved (F372): collapsed, transparent quads at the first anchor, which features
  // appended later overwrite in place instead of rebuilding the batch.
  const lon = valueOf(batch, 'position', 0, 0);
  const lat = valueOf(batch, 'position', 0, 1);
  for (let feature = batch.count; feature < (batch.capacity ?? 0); feature++) {
    for (let c = 0; c < 4; c++) builder.add(lon, lat, 0, HIDDEN_COLOR, HIDDEN_CORNER, undefined, HIDDEN_UV);
    quadIndices(builder);
  }
}

/**
 * Rewrites the vertices of features [first, end) of a quad batch in place (F376, F377); returns false when its arrays do
 * not hold them (the batch must be rebuilt).
 */
export function rewriteQuads(
  batch: BatchContents,
  arrays: LayerArrays,
  first: number,
  end: number,
  images: QuadImages | undefined,
  ground: LayerGround | undefined,
): boolean {
  if (end * 4 > arrays.vertices) return false;
  if (batch.kind === 'point') {
    // Points have no image: the allocation-free path of live feeds (F378).
    for (let feature = first; feature < end; feature++) writePointQuad(batch, arrays, feature, ground);
    return true;
  }
  for (let feature = first; feature < end; feature++) {
    const q = quadVertices(batch, feature, images);
    const height = q.height + (ground?.heightAt(q.lon, q.lat) ?? 0);
    const lon = nearestLon(q.lon, originLonDeg(arrays.origin));
    for (let c = 0; c < 4; c++) {
      const v = feature * 4 + c;
      writeLayerVertex(arrays, v, lon, q.lat, arrays.origin);
      arrays.heights[v] = height;
      arrays.colors.set(q.color, v * 4);
      arrays.corners.set(q.corners[c] ?? [], v * 4);
      arrays.uvs.set(q.uvs[c] ?? HIDDEN_UV, v * 4);
    }
  }
  return true;
}

/** Lines: a quad per segment, its vertices offset across the projected segment by half the width. */
function buildLines(batch: BatchContents, builder: Builder): void {
  for (let feature = 0; feature < batch.count; feature++) {
    const geometry = batch.geometry.get(feature);
    if (!geometry || valueOf(batch, 'visible', feature) <= 0) continue;
    const step = builder.stepDeg(extentOf(geometry));
    const color = colorOf(batch, feature);
    const half = valueOf(batch, 'widthPx', feature) / 2;
    builder.startFeature('chain');
    forEachPart(geometry, (start, end) => {
      for (let i = start; i + 1 < end; i++) {
        // Long segments follow the surface: pieces of at most MAX_STEP_DEG along the great circle.
        const pieces = greatCirclePoints(vertexOf(geometry, i), vertexOf(geometry, i + 1), step);
        for (let k = 0; k + 1 < pieces.length; k++) {
          const a = pieces[k] ?? [0, 0, 0];
          const b = pieces[k + 1] ?? [0, 0, 0];
          // The far end sees the segment reversed: its sides are flipped so the quad stays one band.
          builder.add(a[0], a[1], a[2], color, [1, half, 0, 0], b);
          builder.add(a[0], a[1], a[2], color, [-1, half, 0, 0], b);
          builder.add(b[0], b[1], b[2], color, [1, half, 0, 0], a);
          builder.add(b[0], b[1], b[2], color, [-1, half, 0, 0], a);
          quadIndices(builder);
        }
      }
    });
  }
}

/** Polygons: triangulated with their holes; with a height, extruded as walls and a roof (`fill-extrusion`). */
function buildPolygons(batch: BatchContents, builder: Builder): void {
  for (let feature = 0; feature < batch.count; feature++) {
    const geometry = batch.geometry.get(feature);
    if (!geometry || valueOf(batch, 'visible', feature) <= 0) continue;
    const step = builder.stepDeg(extentOf(geometry));
    const color = colorOf(batch, feature);
    const top = valueOf(batch, 'heightMeters', feature);
    const base = valueOf(batch, 'baseMeters', feature);
    const starts = geometry.polygonStarts ?? Uint32Array.of(0);
    for (let p = 0; p < starts.length; p++) {
      const firstPart = starts[p] ?? 0;
      const lastPart = starts[p + 1] ?? geometry.partStarts.length;
      const { vertices, holes } = unwrappedPolygon(geometry, firstPart, lastPart, builder.originLon);
      const flat = vertices.flatMap((v) => [v[0], v[1]]);
      const triangles = earcut(flat, holes);
      builder.startFeature('raw');
      // A ring around a pole repeats on the flat map's neighboring world copies (corner.w = 1, hidden near the globe).
      for (const shift of worldCopies(vertices))
        for (let t = 0; t + 2 < triangles.length; t += 3) {
          const corners = [0, 1, 2].map((c) => vertices[triangles[t + c] ?? 0] ?? [0, 0, 0]);
          // Large triangles follow the surface: split until every edge is at most MAX_STEP_DEG.
          for (const triangle of subdivide(corners as Triangle, step)) {
            for (const v of triangle)
              builder.add(v[0] + shift, v[1], top > 0 ? top : v[2], color, [0, 0, 0, shift ? 1 : 0]);
            const at = builder.count - 3;
            builder.indices.push(at, at + 1, at + 2);
          }
        }
      if (top > 0) buildWalls(geometry, builder, firstPart, lastPart, base, top, color);
    }
  }
}

function buildWalls(
  geometry: FeatureGeometry,
  builder: Builder,
  firstPart: number,
  lastPart: number,
  base: number,
  top: number,
  color: number[],
): void {
  // Walls a little darker than the roof, so the volume reads.
  const wall = [(color[0] ?? 0) * 0.8, (color[1] ?? 0) * 0.8, (color[2] ?? 0) * 0.8, color[3] ?? 1];
  for (let part = firstPart; part < lastPart; part++) {
    const start = geometry.partStarts[part] ?? 0;
    const end = geometry.partStarts[part + 1] ?? geometry.positions.length / 3;
    for (let i = start; i < end; i++) {
      const a = vertexOf(geometry, i);
      const b = vertexOf(geometry, i + 1 < end ? i + 1 : start);
      builder.add(a[0], a[1], base, wall, [0, 0, 0, 0]);
      builder.add(b[0], b[1], base, wall, [0, 0, 0, 0]);
      builder.add(b[0], b[1], top, wall, [0, 0, 0, 0]);
      builder.add(a[0], a[1], top, wall, [0, 0, 0, 0]);
      quadIndices(builder);
    }
  }
}

/** The first position a batch holds, its origin (ADR 0004), or undefined when it holds nothing to draw. */
function firstPosition(batch: BatchContents): [number, number] | undefined {
  if (batch.kind === 'polyline' || batch.kind === 'polygon' || batch.kind === 'circle') {
    for (const geometry of batch.geometry.values())
      if (geometry.positions.length >= 2) return [geometry.positions[0] ?? 0, geometry.positions[1] ?? 0];
    return undefined;
  }
  return batch.count > 0 ? [valueOf(batch, 'position', 0, 0), valueOf(batch, 'position', 0, 1)] : undefined;
}

/** The vertex arrays of a batch's visible features, or undefined when there is nothing to draw. */
export function buildLayerArrays(
  batch: BatchContents,
  images?: QuadImages,
  ground?: LayerGround,
): LayerArrays | undefined {
  const first = firstPosition(batch);
  if (!first) return undefined;
  const builder = new Builder(layerOrigin(first[0], first[1]), ground);
  if (batch.kind === 'polyline') buildLines(batch, builder);
  // Circles arrive as their geodesic outlines (the layers package's `ellipseGeometry`).
  else if (batch.kind === 'polygon' || batch.kind === 'circle') buildPolygons(batch, builder);
  else buildQuads(batch, builder, images);
  return builder.count > 0 ? builder.arrays(batch.kind === 'polyline') : undefined;
}

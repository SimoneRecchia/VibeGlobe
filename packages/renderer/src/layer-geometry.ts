import {
  ATTRIBUTE_COMPONENTS,
  layerOrigin,
  writeLayerVertex,
  type BatchAttribute,
  type BatchKind,
  type FeatureGeometry,
  type LayerOrigin,
} from '@vibeglobe/core';
import earcut from 'earcut';

/** What a batch holds on the CPU: per-feature attributes, uniform overrides, strings and geometry (ADR 0037). */
export interface BatchContents {
  readonly kind: BatchKind;
  count: number;
  readonly attributes: Map<BatchAttribute, Float64Array>;
  readonly uniforms: Map<BatchAttribute, Float64Array>;
  readonly strings: Map<'text' | 'icon', string[]>;
  readonly geometry: Map<number, FeatureGeometry>;
}

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
  /** Atlas coordinates of labels and marker images; (−1, −1) where a quad is a solid shape. */
  readonly uvs: Float32Array;
  readonly indices: Uint32Array;
  /** Lines only: the other endpoint of each vertex's segment. */
  readonly other?: { positions: Float32Array; normals: Float32Array; planes: Float32Array; heights: Float32Array };
}

/** Defaults of attributes a layer did not write. */
const DEFAULTS: Partial<Record<BatchAttribute, readonly number[]>> = {
  color: [1, 1, 1, 1],
  sizePx: [8],
  widthPx: [2],
  opacity: [1],
  visible: [1],
  offsetPx: [0, 0],
  heightMeters: [0],
  baseMeters: [0],
};

/** Component `component` of a feature's attribute: its uniform override, its own value, or the default. */
export function valueOf(batch: BatchContents, attribute: BatchAttribute, feature: number, component = 0): number {
  const uniform = batch.uniforms.get(attribute);
  if (uniform) return uniform[component] ?? 0;
  const values = batch.attributes.get(attribute);
  const own = values?.[feature * ATTRIBUTE_COMPONENTS[attribute] + component];
  return own ?? DEFAULTS[attribute]?.[component] ?? 0;
}

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

  constructor(readonly origin: LayerOrigin) {}

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
    uv: number[] = [-1, -1],
  ): void {
    this.attributesOf(lonDeg, latDeg, this);
    this.heights.push(heightMeters);
    this.colors.push(...color);
    this.corners.push(...corner);
    this.uvs.push(...uv);
    if (to) {
      this.attributesOf(to[0] ?? 0, to[1] ?? 0, this.other);
      this.other.heights.push(to[2] ?? 0);
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

/** Where labels and marker images come from (`LayerAtlas`). */
export interface QuadImages {
  text(text: string, sizePx: number): AtlasRect;
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

/** The box of a quad feature: half-sizes and its atlas region (none: a solid shape). */
function boxOf(
  batch: BatchContents,
  feature: number,
  images: QuadImages | undefined,
): { w: number; h: number; rect: AtlasRect | undefined } {
  const size = valueOf(batch, 'sizePx', feature);
  // Points and circles: `sizePx` is the radius (MapLibre `circle-radius`).
  if (batch.kind === 'point' || batch.kind === 'circle') return { w: size, h: size, rect: undefined };
  if (batch.kind === 'label') {
    const rect = images?.text(batch.strings.get('text')?.[feature] ?? '', size);
    return rect ? { w: rect.widthPx / 2, h: rect.heightPx / 2, rect } : { w: size / 2, h: size / 2, rect };
  }
  // Markers: the image at `sizePx` tall (its natural height when unset), or a solid square without one.
  const name = batch.strings.get('icon')?.[feature] ?? '';
  const rect = images?.image(name);
  if (!rect) return { w: size / 2, h: size / 2, rect };
  const h = (batch.attributes.has('sizePx') || batch.uniforms.has('sizePx') ? size : rect.heightPx) / 2;
  return { w: (h * rect.widthPx) / rect.heightPx, h, rect };
}

/** Points, markers, circles and labels: a screen-sized quad around each feature's position. */
function buildQuads(batch: BatchContents, builder: Builder, images: QuadImages | undefined): void {
  for (let feature = 0; feature < batch.count; feature++) {
    if (valueOf(batch, 'visible', feature) <= 0) continue;
    const lon = valueOf(batch, 'position', feature, 0);
    const lat = valueOf(batch, 'position', feature, 1);
    const height = valueOf(batch, 'position', feature, 2);
    const { w, h, rect } = boxOf(batch, feature, images);
    const [ax, ay] = anchorShift(valueOf(batch, 'anchor', feature), w, h);
    const dx = valueOf(batch, 'offsetPx', feature, 0) + ax;
    const dy = -valueOf(batch, 'offsetPx', feature, 1) + ay;
    const angle = (-valueOf(batch, 'rotationDeg', feature) * Math.PI) / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const round = batch.kind === 'point' || batch.kind === 'circle';
    // Marker images keep their own colors (MapLibre tints only SDF icons): white, with the feature's alpha.
    const color =
      batch.kind === 'marker' && rect ? [1, 1, 1, colorOf(batch, feature)[3] ?? 1] : colorOf(batch, feature);
    for (const [sx, sy] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ] as const) {
      const x = sx * w;
      const y = sy * h;
      // corner.zw: the unit square for round points, 2 for every other quad.
      const corner = [dx + x * cos - y * sin, dy + x * sin + y * cos, round ? sx : 2, round ? sy : 2];
      // Atlas rows run downward: the quad's top (sy = 1) samples v0.
      const uv = rect ? [sx < 0 ? rect.u0 : rect.u1, sy > 0 ? rect.v0 : rect.v1] : [-1, -1];
      builder.add(lon, lat, height, color, corner, undefined, uv);
    }
    quadIndices(builder);
  }
}

/** Lines: a quad per segment, its vertices offset across the projected segment by half the width. */
function buildLines(batch: BatchContents, builder: Builder): void {
  for (let feature = 0; feature < batch.count; feature++) {
    const geometry = batch.geometry.get(feature);
    if (!geometry || valueOf(batch, 'visible', feature) <= 0) continue;
    const color = colorOf(batch, feature);
    const half = valueOf(batch, 'widthPx', feature) / 2;
    forEachPart(geometry, (start, end) => {
      for (let i = start; i + 1 < end; i++) {
        // Long segments follow the surface: pieces of at most MAX_STEP_DEG along the great circle.
        const pieces = greatCirclePoints(vertexOf(geometry, i), vertexOf(geometry, i + 1));
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
    const color = colorOf(batch, feature);
    const top = valueOf(batch, 'heightMeters', feature);
    const base = valueOf(batch, 'baseMeters', feature);
    const starts = geometry.polygonStarts ?? Uint32Array.of(0);
    for (let p = 0; p < starts.length; p++) {
      const firstPart = starts[p] ?? 0;
      const lastPart = starts[p + 1] ?? geometry.partStarts.length;
      const first = geometry.partStarts[firstPart] ?? 0;
      const end = geometry.partStarts[lastPart] ?? geometry.positions.length / 3;
      const flat: number[] = [];
      for (let i = first; i < end; i++) flat.push(geometry.positions[i * 3] ?? 0, geometry.positions[i * 3 + 1] ?? 0);
      const holes: number[] = [];
      for (let part = firstPart + 1; part < lastPart; part++) holes.push((geometry.partStarts[part] ?? 0) - first);
      const triangles = earcut(flat, holes);
      for (let t = 0; t + 2 < triangles.length; t += 3) {
        const corners = [0, 1, 2].map((c) => vertexOf(geometry, first + (triangles[t + c] ?? 0)));
        // Large triangles follow the surface: split until every edge is at most MAX_STEP_DEG.
        for (const triangle of subdivide(corners as Triangle)) {
          for (const v of triangle) builder.add(v[0], v[1], top > 0 ? top : v[2], color, [0, 0, 0, 0]);
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

/** The longest edge, degrees, drawn as one straight piece: shorter ones stay within a few meters of the surface. */
const MAX_STEP_DEG = 1;

type Vertex = [number, number, number];
type Triangle = [Vertex, Vertex, Vertex];

/** Points from `a` to `b` (degrees, meters) along the great circle, at most {@link MAX_STEP_DEG} apart. */
function greatCirclePoints(a: Vertex, b: Vertex): Vertex[] {
  const steps = Math.ceil(Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])) / MAX_STEP_DEG);
  if (steps <= 1) return [a, b];
  const rad = Math.PI / 180;
  const unit = (v: Vertex): number[] => [
    Math.cos(v[1] * rad) * Math.cos(v[0] * rad),
    Math.cos(v[1] * rad) * Math.sin(v[0] * rad),
    Math.sin(v[1] * rad),
  ];
  const p = unit(a);
  const q = unit(b);
  const angle = Math.acos(
    Math.min(1, Math.max(-1, (p[0] ?? 0) * (q[0] ?? 0) + (p[1] ?? 0) * (q[1] ?? 0) + (p[2] ?? 0) * (q[2] ?? 0))),
  );
  const points: Vertex[] = [a];
  for (let i = 1; i < steps; i++) {
    const f = i / steps;
    const wa = angle > 1e-12 ? Math.sin((1 - f) * angle) / Math.sin(angle) : 1 - f;
    const wb = angle > 1e-12 ? Math.sin(f * angle) / Math.sin(angle) : f;
    const x = wa * (p[0] ?? 0) + wb * (q[0] ?? 0);
    const y = wa * (p[1] ?? 0) + wb * (q[1] ?? 0);
    const z = wa * (p[2] ?? 0) + wb * (q[2] ?? 0);
    points.push([Math.atan2(y, x) / rad, Math.atan2(z, Math.hypot(x, y)) / rad, a[2] + f * (b[2] - a[2])]);
  }
  points.push(b);
  return points;
}

/** A triangle split in four at its edge midpoints (degrees) until no edge exceeds {@link MAX_STEP_DEG}. */
function subdivide(triangle: Triangle): Triangle[] {
  const [a, b, c] = triangle;
  const span = (u: Vertex, v: Vertex): number => Math.max(Math.abs(u[0] - v[0]), Math.abs(u[1] - v[1]));
  if (Math.max(span(a, b), span(b, c), span(c, a)) <= MAX_STEP_DEG) return [triangle];
  const mid = (u: Vertex, v: Vertex): Vertex => [(u[0] + v[0]) / 2, (u[1] + v[1]) / 2, (u[2] + v[2]) / 2];
  const ab = mid(a, b);
  const bc = mid(b, c);
  const ca = mid(c, a);
  return [...subdivide([a, ab, ca]), ...subdivide([ab, b, bc]), ...subdivide([ca, bc, c]), ...subdivide([ab, bc, ca])];
}

function vertexOf(geometry: FeatureGeometry, i: number): [number, number, number] {
  return [geometry.positions[i * 3] ?? 0, geometry.positions[i * 3 + 1] ?? 0, geometry.positions[i * 3 + 2] ?? 0];
}

function forEachPart(geometry: FeatureGeometry, visit: (start: number, end: number) => void): void {
  for (let part = 0; part < geometry.partStarts.length; part++)
    visit(geometry.partStarts[part] ?? 0, geometry.partStarts[part + 1] ?? geometry.positions.length / 3);
}

/** The first position a batch holds, its origin (ADR 0004), or undefined when it holds nothing to draw. */
function firstPosition(batch: BatchContents): [number, number] | undefined {
  if (batch.kind === 'polyline' || batch.kind === 'polygon') {
    for (const geometry of batch.geometry.values())
      if (geometry.positions.length >= 2) return [geometry.positions[0] ?? 0, geometry.positions[1] ?? 0];
    return undefined;
  }
  return batch.count > 0 ? [valueOf(batch, 'position', 0, 0), valueOf(batch, 'position', 0, 1)] : undefined;
}

/** The vertex arrays of a batch's visible features, or undefined when there is nothing to draw. */
export function buildLayerArrays(batch: BatchContents, images?: QuadImages): LayerArrays | undefined {
  const first = firstPosition(batch);
  if (!first) return undefined;
  const builder = new Builder(layerOrigin(first[0], first[1]));
  if (batch.kind === 'polyline') buildLines(batch, builder);
  else if (batch.kind === 'polygon') buildPolygons(batch, builder);
  else buildQuads(batch, builder, images);
  return builder.count > 0 ? builder.arrays(batch.kind === 'polyline') : undefined;
}
